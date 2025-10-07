/*
   Medicine Dispenser Project
   ESP32 DevKit V1 with Arduino Framework

   Full flow:
    - Boot + SPIFFS + WiFi + Web UI
    - Slot mapping (slotMap.txt)
    - Schedule management (schedule.txt)
    - Dispensing routine for 8-segment drum (7 pill slots + 1 hole)
    - Non-blocking web handlers (manual dispense queued)
    - Logging to /log.txt
*/

// ---------------------- Libraries ----------------------
#include <Wire.h>
#include <U8g2lib.h>
#include <RTClib.h>
#include <AccelStepper.h>
#include <Preferences.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <SPIFFS.h>
#include <DNSServer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <ArduinoJson.h>

// Add these variables to the global variables section
unsigned long lastEmptyCheckTime[2] = {0, 0};     // For Drum 1 and 2
const unsigned long EMPTY_CHECK_INTERVAL = 60000; // Check every minute
unsigned long emptyDisplayUntil[2] = {0, 0};      // Timeout for empty drum display (in milliseconds)
String lastOled1Content = "";
String lastOled2Content = "";

// Time update tracking
unsigned long lastTimeUpdate = 0;
const unsigned long TIME_UPDATE_INTERVAL = 5000; // Update every 5 seconds

// ---------------------- Logging Macros ----------------------
#define logInfo(msg) Serial.println(String("[INFO] ") + msg)
#define logError(msg) Serial.println(String("[ERROR] ") + msg)

// ---------------------- WiFi Credentials ----------------------
const char *ssid = "MedDispenser_AP";
const char *password = "12345678";

// ---------------------- Global Objects ----------------------
Preferences preferences;
AsyncWebServer server(80);
RTC_DS3231 rtc;
DNSServer dnsServer;
SemaphoreHandle_t i2c_mutex;

// OLEDs with explicit I2C addresses
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled1(U8G2_R0, U8X8_PIN_NONE, 22, 21); // Hardware I2C on pins 21(SDA), 22(SCL)
U8G2_SSD1306_128X64_NONAME_F_SW_I2C oled2(U8G2_R0, 13, 17, U8X8_PIN_NONE); // Software I2C on pins 17(SDA), 13(SCL)

// ---------------------- Stepper ----------------------
AccelStepper stepper1(AccelStepper::HALF4WIRE, 14, 26, 27, 25);
AccelStepper stepper2(AccelStepper::HALF4WIRE, 23, 18, 19, 4);

// ---------------------- Pins ----------------------
const int buzzerPin = 15;
const int buttonPin = 2;

// ---------------------- Drum geometry ----------------------
#define STEPS_PER_REV 4096
const int totalSlots = 8;
const int stepsPerSlot = STEPS_PER_REV / totalSlots;

// ---------------------- Slot Tracking ----------------------
int currentSlotDrum1 = 1;
int currentSlotDrum2 = 1;

// ---------------------- Daily Schedule Management ----------------------
struct DailyScheduleEntry
{
    int drum;
    int hour;
    int minute;
    int pills;
    bool executed_today = false;
};
#define MAX_DAILY_SCHEDULES 10
DailyScheduleEntry dailySchedules[MAX_DAILY_SCHEDULES];
int dailyScheduleCount = 0;

// --- Daily Reset Tracking ---
int lastCheckedDay = 0;

// ---------------------- Slot Mapping ----------------------
struct SlotMapEntry
{
    int drum;
    int slot;
    String pillName;
};
#define MAX_SLOTS 20
SlotMapEntry slotMap[MAX_SLOTS];
int slotMapCount = 0;

// ---------------------- State Management ----------------------
bool buzzerActive = false;
unsigned long buzzerStart = 0;
unsigned long lastToneStep = 0;
int currentFreq = 500;
const unsigned long toneStepInterval = 500;
const unsigned long buzzerDuration = 60000;

volatile int pendingDispenseDrum = 0;
volatile int pendingDispensePills = 1;

enum SystemState
{
    IDLE,
    DISPENSING_DRUM1,
    DISPENSING_DRUM2,
    RESETTING
};
SystemState currentState = IDLE;

struct PendingConfirmation
{
    bool active = false;
    int drum = 0;
    int slot = 0;
    String pillName = "";
} pendingConfirmation;

struct LastActionStatus
{
    String timestamp = "";
    String event = "System just booted.";
} lastAction;

struct HistoryEntry
{
    String timestamp, event, medicine, drum, slot, details;
};

unsigned long takenDisplayUntil = 0;
String takenDisplayPill = "";
int takenDisplayDrum = 0;

// NEW: State to track if a drum is considered empty for the next dose
bool drumIsEffectivelyEmpty[2] = {false, false}; // Index 0 for Drum 1, 1 for Drum 2
int pillsBeingDispensed = 0;

// ---------------------- Function Prototypes ----------------------
void initSerial();
void initSPIFFS();
void initPreferences();
void initWiFi();
void handleDispenseFinished(int drum, int pills);
void initWebServer();
void initRTC();
void initOLEDs();
void initSteppers();
void initIO();
void loadSchedules();
void checkSchedules();
void loadSlotMap();
String getPillName(int drum, int slot);
String getPillNameForSlot(int drum, int slot);
bool updateOledDisplay(int drum, const String &line1, const String &line2);
void showErrorOnOled(int drum, const String &errorMsg);
void dispensePill(int drum, int pills = 1);
void logEvent(String eventMessage, bool updateLastAction);
void startBuzzerGradual();
void stopBuzzer();
void updateOledsWithNextSchedule();
DateTime getRTCTime();
void showTakenOnOled(int drum, const String &pill);
void showEmptyOnOled(int drum);
void showDispensingOnOled(int drum, int pills);
void saveSchedules();
void saveSlotMap();
void updateSlotMapEntry(int drum, int slot, String pillName);
bool updateOledDisplay(int drum, const String &line1, const String &line2);
void showErrorOnOled(int drum, const String &errorMsg);

// ---------------------- Setup ----------------------
void setup()
{
    i2c_mutex = xSemaphoreCreateMutex();
    initSerial();
    logInfo("Booting...");
    initSPIFFS();
    initPreferences();
    initWiFi();
    initWebServer();
    initRTC();
    initOLEDs();
    initSteppers();
    initIO();
    noTone(buzzerPin);
    loadSlotMap();   // Load slot map first
    loadSchedules(); // Then schedules
    updateOledsWithNextSchedule();
    logInfo("Boot sequence complete.");
}

// ---------------------- Loop ----------------------
void loop()
{
    dnsServer.processNextRequest();

    // Check for refilled drums periodically
    for (int d = 0; d < 2; d++)
    {
        if (drumIsEffectivelyEmpty[d] && millis() - lastEmptyCheckTime[d] > EMPTY_CHECK_INTERVAL)
        {
            lastEmptyCheckTime[d] = millis();

            // Scan all slots (1..7) to detect any refilled position
            bool refilled = false;
            for (int s = 1; s <= 7; s++)
            {
                String p = getPillNameForSlot(d + 1, s);
                if (p != "Empty" && p != "Ready to insert")
                {
                    refilled = true;
                    break;
                }
            }

            if (refilled)
            {
                logInfo("Drum " + String(d + 1) + " has pills detected. Clearing empty state.");
                drumIsEffectivelyEmpty[d] = false;
                emptyDisplayUntil[d] = 0;      // Reset the display timeout
                updateOledsWithNextSchedule(); // Update the display
            }
        }
    }

    if (currentState == IDLE)
    {
        checkSchedules();
        
        // Update OLED displays with current time every 5 seconds
        if (millis() - lastTimeUpdate >= TIME_UPDATE_INTERVAL)
        {
            lastTimeUpdate = millis();
            // Only update if not showing other messages (buzzer not active, no pending confirmation)
            if (!buzzerActive && takenDisplayUntil == 0)
            {
                updateOledsWithNextSchedule();
            }
        }
    }

    if (currentState == IDLE && pendingDispenseDrum != 0)
    {
        int drum = pendingDispenseDrum;
        pendingDispenseDrum = 0;
        logInfo("Processing queued dispense for Drum " + String(drum) + " for " + String(pendingDispensePills) + " pills.");
        dispensePill(drum, pendingDispensePills);
    }

    if (currentState == DISPENSING_DRUM1 && stepper1.distanceToGo() == 0)
    {
        handleDispenseFinished(1, pillsBeingDispensed);
        currentState = IDLE;
    }
    else if (currentState == DISPENSING_DRUM2 && stepper2.distanceToGo() == 0)
    {
        handleDispenseFinished(2, pillsBeingDispensed);
        currentState = IDLE;
    }

    if (buzzerActive)
    {
        if (millis() - lastToneStep >= toneStepInterval)
        {
            lastToneStep = millis();
            if (currentFreq < 4000)
                currentFreq += 200;
            tone(buzzerPin, currentFreq);
        }
        if (millis() - buzzerStart >= buzzerDuration)
        {
            stopBuzzer();
            if (pendingConfirmation.active)
            {
                logEvent("MISSED: " + pendingConfirmation.pillName + " from Drum " + String(pendingConfirmation.drum), true);
                pendingConfirmation.active = false;
            }
            updateOledsWithNextSchedule();
        }
    }

    if (buzzerActive && digitalRead(buttonPin) == LOW)
    {
        stopBuzzer();
        if (pendingConfirmation.active)
        {
            int pd = pendingConfirmation.drum;
            String pill = pendingConfirmation.pillName;
            logEvent("TAKEN: " + pill + " from Drum " + String(pd), true);
            showTakenOnOled(pd, pill);
            takenDisplayUntil = millis() + 15000; // Show "Taken" for 15 seconds
            pendingConfirmation.active = false;
        }
    }

    if (takenDisplayUntil != 0 && millis() >= takenDisplayUntil)
    {
        takenDisplayUntil = 0;
        updateOledsWithNextSchedule();
    }

    stepper1.run();
    stepper2.run();
    delay(1);
}

// ---------------------- Initializations ----------------------
void initSerial()
{
    Serial.begin(115200);
    delay(200);
}
void initSPIFFS()
{
    if (!SPIFFS.begin(true))
    {
        logError("SPIFFS mount failed.");
    }
}
void initPreferences()
{
    preferences.begin("medDispenser", false);
    currentSlotDrum1 = preferences.getInt("slotDrum1", 1);
    currentSlotDrum2 = preferences.getInt("slotDrum2", 1);
    lastCheckedDay = preferences.getInt("lastDay", 0);
}
void initWiFi()
{
    WiFi.softAP(ssid, password);
    IPAddress IP = WiFi.softAPIP();
    dnsServer.start(53, "*", IP);
    logInfo("AP IP: " + IP.toString());
}
void initSteppers()
{
    stepper1.setMaxSpeed(500.0);
    stepper1.setAcceleration(500.0);
    stepper2.setMaxSpeed(500.0);
    stepper2.setAcceleration(500.0);
}
void initIO()
{
    pinMode(buzzerPin, OUTPUT);
    pinMode(buttonPin, INPUT_PULLUP);
}
// I2C Scanner function for debugging
void scanI2C() {
    logInfo("Scanning I2C bus...");
    int deviceCount = 0;
    
    for (byte address = 1; address < 127; address++) {
        Wire.beginTransmission(address);
        byte error = Wire.endTransmission();
        
        if (error == 0) {
            logInfo("I2C device found at address 0x" + String(address, HEX));
            deviceCount++;
        }
    }
    
    if (deviceCount == 0) {
        logError("No I2C devices found!");
    } else {
        logInfo("Found " + String(deviceCount) + " I2C device(s)");
    }
}

void initRTC()
{
    // Initialize I2C with explicit pins
    Wire.begin(21, 22); // SDA=21, SCL=22 for ESP32
    Wire.setClock(100000); // Set I2C clock to 100kHz for better stability
    
    // Scan I2C bus for debugging
    scanI2C();
    
    if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(3000)) == pdTRUE)
    {
        logInfo("Attempting to initialize RTC...");
        
        // Try multiple times to initialize RTC
        bool rtcFound = false;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (rtc.begin()) {
                rtcFound = true;
                logInfo("RTC initialized successfully on attempt " + String(attempt + 1));
                break;
            }
            delay(500);
        }
        
        if (!rtcFound) {
            logError("RTC not found after multiple attempts. Check wiring and I2C address.");
            xSemaphoreGive(i2c_mutex);
            return;
        }

        bool rtcInitialized = preferences.getBool("rtcInit", false);
        DateTime now = rtc.now();
        bool invalidTime = (now.year() < 2020 || now.year() > 2030);

        if (!rtcInitialized || invalidTime) {
            logInfo("Setting RTC to compile time: " + String(__DATE__) + " " + String(__TIME__));
            rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
            preferences.putBool("rtcInit", true);
            
            // Verify the time was set correctly
            delay(100);
            DateTime verifyTime = rtc.now();
            logInfo("RTC time set to: " + String(verifyTime.year()) + "-" + 
                   String(verifyTime.month()) + "-" + String(verifyTime.day()) + " " +
                   String(verifyTime.hour()) + ":" + String(verifyTime.minute()) + ":" + String(verifyTime.second()));
        } else {
            DateTime currentTime = rtc.now();
            logInfo("RTC already initialized. Current time: " + String(currentTime.year()) + "-" + 
                   String(currentTime.month()) + "-" + String(currentTime.day()) + " " +
                   String(currentTime.hour()) + ":" + String(currentTime.minute()) + ":" + String(currentTime.second()));
        }

        xSemaphoreGive(i2c_mutex);
    } else {
        logError("Could not acquire I2C mutex for RTC initialization");
    }
}
DateTime getRTCTime()
{
    DateTime now;
    if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(1000)) == pdTRUE)
    {
        now = rtc.now();
        xSemaphoreGive(i2c_mutex);
    }
    else
    {
        logError("Could not get I2C mutex for RTC read.");
        now = DateTime((uint32_t)0);
    }
    return now;
}
void initOLEDs()
{
    logInfo("Initializing OLED displays...");
    
    // Initialize OLED1 (Hardware I2C) with mutex protection
    if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(3000)) == pdTRUE)
    {
        bool oled1Success = false;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (oled1.begin()) {
                oled1Success = true;
                logInfo("OLED1 initialized successfully on attempt " + String(attempt + 1));
                break;
            }
            delay(200);
        }
        
        if (!oled1Success) {
            logError("OLED1 not found after multiple attempts. Check wiring and I2C address (should be 0x3C).");
        } else {
            oled1.clearBuffer();
            oled1.setFont(u8g2_font_ncenB08_tr);
            oled1.drawStr(0, 15, "Drum 1 Ready");
            oled1.drawStr(0, 30, "Initializing...");
            oled1.sendBuffer();
        }
        xSemaphoreGive(i2c_mutex);
    } else {
        logError("Could not acquire I2C mutex for OLED1 initialization");
    }

    // Initialize OLED2 (Software I2C) - no mutex needed
    bool oled2Success = false;
    for (int attempt = 0; attempt < 3; attempt++) {
        if (oled2.begin()) {
            oled2Success = true;
            logInfo("OLED2 initialized successfully on attempt " + String(attempt + 1));
            break;
        }
        delay(200);
    }
    
    if (!oled2Success) {
        logError("OLED2 not found after multiple attempts. Check wiring and I2C address (should be 0x3D).");
    } else {
        oled2.clearBuffer();
        oled2.setFont(u8g2_font_ncenB08_tr);
        oled2.drawStr(0, 15, "Drum 2 Ready");
        oled2.drawStr(0, 30, "Initializing...");
        oled2.sendBuffer();
    }
    
    logInfo("OLED initialization complete");
}

// ---------------------- Web Server ----------------------
void initWebServer()
{
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(SPIFFS, "/index.html", "text/html"); });
    server.on("/style.css", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(SPIFFS, "/style.css", "text/css"); });
    server.on("/script.js", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(SPIFFS, "/script.js", "application/javascript"); });
    server.on("/history.html", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(SPIFFS, "/history.html", "text/html"); });

    server.on("/status", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        DateTime now = getRTCTime();
        char timeBuf[20];
        snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d:%02d", now.hour(), now.minute(), now.second());
        
        JsonDocument doc;
        doc["time"] = timeBuf;
        doc["slotDrum1"] = currentSlotDrum1;
        doc["slotDrum2"] = currentSlotDrum2;
        doc["wifi"] = WiFi.softAPIP().toString();

        String jsonBuf;
        serializeJson(doc, jsonBuf);
        request->send(200, "application/json", jsonBuf); });

    server.on("/getSlotMap", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        JsonDocument doc;
        for (int i = 0; i < slotMapCount; i++) {
            JsonObject obj = doc.add<JsonObject>();
            obj["drum"] = slotMap[i].drum;
            obj["slot"] = slotMap[i].slot;
            obj["pillName"] = slotMap[i].pillName;
        }
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json); });

    server.on("/logs", HTTP_GET, [](AsyncWebServerRequest *request)
              { request->send(SPIFFS, "/log.txt", "text/plain"); });

    // Structured history API for history.html
    server.on("/api/history", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        File f = SPIFFS.open("/log.txt", FILE_READ);
        const int MAX_ITEMS = 300; // limit to last N entries to keep response reasonable
        String lines[MAX_ITEMS];
        int count = 0;
        if (f) {
            while (f.available()) {
                String line = f.readStringUntil('\n');
                line.trim();
                if (line.length() == 0) continue;
                lines[count % MAX_ITEMS] = line;
                count++;
            }
            f.close();
        }
        int total = count < MAX_ITEMS ? count : MAX_ITEMS;
        int start = (count > MAX_ITEMS) ? (count % MAX_ITEMS) : 0;
        String out = "[";
        bool first = true;
        for (int i = 0; i < total; i++) {
            String line = lines[(start + i) % MAX_ITEMS];
            int closeBracket = line.indexOf(']');
            int openBracket = line.indexOf('[');
            if (openBracket == 0 && closeBracket > 0 && closeBracket + 2 <= (int)line.length()) {
                String ts = line.substring(openBracket + 1, closeBracket);
                String msg = line.substring(closeBracket + 2);
                appendHistoryItemJson(out, ts, msg, first);
            }
        }
        out += "]";
        request->send(200, "application/json", out); });

    // API endpoint for upcoming schedules (dashboard)
    server.on("/api/upcoming-schedules", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        DateTime now = rtc.now();
        JsonDocument doc;
        JsonArray schedules = doc.to<JsonArray>();
        
        // Find upcoming schedules for today and tomorrow
        for (int day = 0; day < 2; day++) {
            DateTime targetDate = now + TimeSpan(day, 0, 0, 0);
            
            for (int i = 0; i < dailyScheduleCount; i++) {
                // For today, only show future schedules; for tomorrow, show all
                bool isToday = (day == 0);
                bool isFuture = (dailySchedules[i].hour > now.hour()) || 
                               (dailySchedules[i].hour == now.hour() && dailySchedules[i].minute > now.minute());
                bool shouldInclude = !isToday || (isFuture && !dailySchedules[i].executed_today);
                
                if (shouldInclude) {
                    JsonObject schedule = schedules.add<JsonObject>();
                    schedule["drum"] = dailySchedules[i].drum;
                    schedule["hour"] = dailySchedules[i].hour;
                    schedule["minute"] = dailySchedules[i].minute;
                    schedule["pills"] = dailySchedules[i].pills;
                    schedule["executed"] = dailySchedules[i].executed_today;
                    schedule["medicine"] = getPillName(dailySchedules[i].drum, 
                                                     (dailySchedules[i].drum == 1) ? currentSlotDrum1 : currentSlotDrum2);
                    
                    // Format date and time
                    char dateStr[11];
                    sprintf(dateStr, "%04d-%02d-%02d", targetDate.year(), targetDate.month(), targetDate.day());
                    schedule["date"] = dateStr;
                    
                    char timeStr[6];
                    sprintf(timeStr, "%02d:%02d", dailySchedules[i].hour, dailySchedules[i].minute);
                    schedule["time"] = timeStr;
                    
                    schedule["day"] = day; // 0 = today, 1 = tomorrow
                }
            }
        }
        
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json); });

    server.on("/api/dispenser-status", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        JsonDocument doc;
        JsonArray drums = doc.createNestedArray("drums");
        
        for (int drum = 1; drum <= 2; drum++) {
            JsonObject drumObj = drums.add<JsonObject>();
            drumObj["drum"] = drum;
            drumObj["currentSlot"] = (drum == 1) ? currentSlotDrum1 : currentSlotDrum2;
            drumObj["isEmpty"] = drumIsEffectivelyEmpty[drum - 1];
            
            JsonArray slots = drumObj.createNestedArray("slots");
            int emptySlots = 0;
            int totalSlots = 7;
            
            for (int slot = 1; slot <= 7; slot++) {
                JsonObject slotObj = slots.add<JsonObject>();
                slotObj["slot"] = slot;
                String pillName = getPillName(drum, slot);
                slotObj["medicine"] = pillName;
                slotObj["isEmpty"] = (pillName == "Empty" || pillName == "Ready to insert");
                if (slotObj["isEmpty"]) emptySlots++;
            }
            
            drumObj["emptySlots"] = emptySlots;
            drumObj["totalSlots"] = totalSlots;
            drumObj["fillPercentage"] = ((totalSlots - emptySlots) * 100) / totalSlots;
        }
        
        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json); });

    server.on("/addSlotMapEntry", HTTP_POST, [](AsyncWebServerRequest *request)
              {
        if (request->hasParam("data", true)) {
            String data = request->getParam("data", true)->value();
            int drum = data.substring(data.indexOf("Drum") + 4, data.indexOf(",")).toInt();
            int slot = data.substring(data.indexOf("Slot") + 4, data.lastIndexOf(",")).toInt();
            String pillName = data.substring(data.lastIndexOf(",") + 2);
            updateSlotMapEntry(drum, slot, pillName);
            request->send(200, "text/plain", "Slot map updated.");
        } else {
            request->send(400, "text/plain", "Missing data.");
        } });

    server.on("/manualDispense", HTTP_POST, [](AsyncWebServerRequest *request)
              {
        if (request->hasParam("drum", true) && request->hasParam("pills", true)) {
            pendingDispenseDrum = request->getParam("drum", true)->value().toInt();
            pendingDispensePills = request->getParam("pills", true)->value().toInt();
            request->send(200, "text/plain", "Manual dispense queued.");
        } else {
            request->send(400, "text/plain", "Missing drum or pills parameter.");
        } });

    server.on("/clearDrums", HTTP_POST, [](AsyncWebServerRequest *request)
              {
        logInfo("Logical drum reset initiated by user.");
        currentSlotDrum1 = 1;
        currentSlotDrum2 = 1;
        preferences.putInt("slotDrum1", 1);
        preferences.putInt("slotDrum2", 1);
        
        drumIsEffectivelyEmpty[0] = false;
        drumIsEffectivelyEmpty[1] = false;

        logEvent("Drums logically reset to Slot 1.", true);
        updateOledsWithNextSchedule();
        request->send(200, "text/plain", "Drums logically reset. You can now refill from slot 1."); });

    server.on("/setDailySchedules", HTTP_POST, [](AsyncWebServerRequest *request)
              {
        if (request->hasParam("data", true)) {
            String data = request->getParam("data", true)->value();
            JsonDocument doc;
            if (deserializeJson(doc, data).code() == DeserializationError::Ok) {
                dailyScheduleCount = 0;
                // Clear existing schedules before adding new ones
                for(int i=0; i<MAX_DAILY_SCHEDULES; ++i) dailySchedules[i] = {};

                JsonArray drum1Times = doc["drum1"]["times"].as<JsonArray>();
                for (JsonVariant time : drum1Times) {
                    if (dailyScheduleCount < MAX_DAILY_SCHEDULES) {
                        dailySchedules[dailyScheduleCount++] = {1, time.as<String>().substring(0, 2).toInt(), time.as<String>().substring(3).toInt(), 1, false};
                    }
                }
                JsonArray drum2Times = doc["drum2"]["times"].as<JsonArray>();
                for (JsonVariant time : drum2Times) {
                    if (dailyScheduleCount < MAX_DAILY_SCHEDULES) {
                        dailySchedules[dailyScheduleCount++] = {2, time.as<String>().substring(0, 2).toInt(), time.as<String>().substring(3).toInt(), 1, false};
                    }
                }
                saveSchedules();
                logEvent("Daily schedules updated by user.", true);
                updateOledsWithNextSchedule();
                request->send(200, "text/plain", "Daily schedules updated successfully.");
            } else {
                request->send(400, "text/plain", "Invalid JSON data.");
            }
        } else {
            request->send(400, "text/plain", "Missing schedule data.");
        } });

    server.on("/lastAction", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        JsonDocument doc;
        doc["timestamp"] = lastAction.timestamp;
        doc["event"] = lastAction.event;
        String jsonBuf;
        serializeJson(doc, jsonBuf);
        request->send(200, "application/json", jsonBuf); });

    server.on("/addMultipleSlotMapEntries", HTTP_POST, [](AsyncWebServerRequest *request)
              {
        if (request->hasParam("data", true)) {
            String data = request->getParam("data", true)->value();
            JsonDocument doc;
            if (deserializeJson(doc, data).code() == DeserializationError::Ok) {
                int drum = doc["drum"].as<int>();
                JsonArray medicines = doc["medicines"].as<JsonArray>();
                
                // Find the next available slot for the given drum
                int nextSlot = 1;
                for (int i = 0; i < slotMapCount; i++) {
                    if (slotMap[i].drum == drum) {
                        if (slotMap[i].slot >= nextSlot) {
                            nextSlot = slotMap[i].slot + 1;
                        }
                    }
                }

                for (JsonObject med : medicines) {
                    if (nextSlot <= 7) {
                        updateSlotMapEntry(drum, nextSlot, med["pillName"].as<String>());
                        nextSlot++;
                    } else {
                        logError("Drum is full. Cannot add more medicines.");
                        break; 
                    }
                }
                request->send(200, "text/plain", "Medicines added successfully.");
            } else {
                request->send(400, "text/plain", "Invalid JSON for multiple medicines.");
            }
        } else {
            request->send(400, "text/plain", "Missing data for multiple medicines.");
        } });

    server.on("/removeSlotMapEntry", HTTP_POST, [](AsyncWebServerRequest *request)
              {
        if (request->hasParam("drum", true) && request->hasParam("slot", true)) {
            int drum = request->getParam("drum", true)->value().toInt();
            int slot = request->getParam("slot", true)->value().toInt();
            
            // Find the entry and remove it by shifting subsequent entries
            int entryIndex = -1;
            for (int i = 0; i < slotMapCount; i++) {
                if (slotMap[i].drum == drum && slotMap[i].slot == slot) {
                    entryIndex = i;
                    break;
                }
            }

            if (entryIndex != -1) {
                for (int i = entryIndex; i < slotMapCount - 1; i++) {
                    slotMap[i] = slotMap[i + 1];
                }
                slotMapCount--;
                saveSlotMap(); // Persist the changes
                logEvent("Removed medicine from Drum " + String(drum) + ", Slot " + String(slot), true);
                request->send(200, "text/plain", "Medicine removed successfully.");
            } else {
                request->send(404, "text/plain", "Medicine entry not found.");
            }
        } else {
            request->send(400, "text/plain", "Missing drum or slot for removal.");
        } });

    server.onNotFound([](AsyncWebServerRequest *request)
                      { request->send(SPIFFS, "/index.html", "text/html"); });
    server.begin();
}

// ---------------------- Core Logic ----------------------

void checkSchedules()
{
    if (dailyScheduleCount == 0)
        return;
    DateTime now = getRTCTime();

    if (now.day() != lastCheckedDay)
    {
        logInfo("New day detected. Resetting daily execution status.");
        for (int i = 0; i < dailyScheduleCount; i++)
        {
            dailySchedules[i].executed_today = false;
        }
        lastCheckedDay = now.day();
        preferences.putInt("lastDay", lastCheckedDay);
        saveSchedules(); // Save the reset executed_today flags
    }

    for (int i = 0; i < dailyScheduleCount; i++)
    {
        if (!dailySchedules[i].executed_today && dailySchedules[i].hour == now.hour() && dailySchedules[i].minute == now.minute())
        {
            int drum = dailySchedules[i].drum;
            if (drumIsEffectivelyEmpty[drum - 1])
            {
                logInfo("Schedule matched for Drum " + String(drum) + ", but it's marked as empty. Skipping.");
                continue; // Skip this schedule
            }

            int currentSlot = (drum == 1) ? currentSlotDrum1 : currentSlotDrum2;
            String pill = getPillName(drum, currentSlot);

            if (pill != "Empty" && pill != "Ready to insert")
            {
                logInfo("Schedule matched: Dispensing " + pill + " from Drum " + String(drum) + " Slot " + String(currentSlot));
                dispensePill(drum, dailySchedules[i].pills);
                dailySchedules[i].executed_today = true;
                saveSchedules(); // Save the executed status
            }
            else
            {
                logInfo("Schedule matched for Drum " + String(drum) + ", but current slot " + String(currentSlot) + " is empty. Halting drum.");
                showEmptyOnOled(drum);
            }
        }
    }
}

// Function to show dispensing status on OLED
void showDispensingOnOled(int drum, int pills)
{
    String line1 = "Dispensing...";
    String line2 = String(pills) + " pill(s)";
    bool displaySuccess = false;
    int retryCount = 0;

    while (!displaySuccess && retryCount < 3)
    {
        if (drum == 1)
        {
            if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(1000)) == pdTRUE)
            {
                oled1.clearBuffer();
                oled1.setFont(u8g2_font_ncenB08_tr);
                oled1.drawStr(0, 20, line1.c_str());
                oled1.drawStr(0, 40, line2.c_str());
                oled1.sendBuffer();
                xSemaphoreGive(i2c_mutex);
                displaySuccess = true;
            }
        }
        else
        {
            if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(1000)) == pdTRUE)
            {
                oled2.clearBuffer();
                oled2.setFont(u8g2_font_ncenB08_tr);
                oled2.drawStr(0, 20, line1.c_str());
                oled2.drawStr(0, 40, line2.c_str());
                oled2.sendBuffer();
                xSemaphoreGive(i2c_mutex);
                displaySuccess = true;
            }
        }

        if (!displaySuccess)
        {
            retryCount++;
            delay(50); // Short delay before retry
        }
    }
}

void dispensePill(int drum, int pills)
{
    if (currentState != IDLE)
    {
        logError("Dispense ignored: system busy.");
        showErrorOnOled(drum, "System busy");
        return;
    }
    pillsBeingDispensed = pills; // Set the global pill count for this operation
    logInfo(String("Dispensing ") + pills + " pill(s) from Drum " + String(drum));

    // Show dispensing status on OLED
    showDispensingOnOled(drum, pills);

    if (drum == 1)
    {
        currentState = DISPENSING_DRUM1;
        stepper1.move(stepsPerSlot * pills);
    }
    else if (drum == 2)
    {
        currentState = DISPENSING_DRUM2;
        stepper2.move(stepsPerSlot * pills);
    }
}

void handleDispenseFinished(int drum, int pills)
{
    int *currentSlotPtr = (drum == 1) ? &currentSlotDrum1 : &currentSlotDrum2;
    String pillName = getPillName(drum, *currentSlotPtr);

    logEvent("DISPENSED: " + pillName + " from Drum " + String(drum) + " Slot " + String(*currentSlotPtr), true);

    // Set up confirmation state BEFORE incrementing slot
    pendingConfirmation = {true, drum, *currentSlotPtr, pillName};

    // Correctly increment the slot number based on the number of pills dispensed
    *currentSlotPtr = (*currentSlotPtr + pills - 1) % 7 + 1;

    preferences.putInt((drum == 1) ? "slotDrum1" : "slotDrum2", *currentSlotPtr);
    logInfo("Drum " + String(drum) + " now logically at Slot " + String(*currentSlotPtr));

    startBuzzerGradual();

    String msg = "Take: " + pillName.substring(0, 15);
    if (drum == 1)
    {
        if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(1000)) == pdTRUE)
        {
            oled1.clearBuffer();
            oled1.setFont(u8g2_font_ncenB08_tr);
            oled1.drawStr(0, 35, msg.c_str());
            oled1.sendBuffer();
            xSemaphoreGive(i2c_mutex);
        }
    }
    else
    {
        oled2.clearBuffer();
        oled2.setFont(u8g2_font_ncenB08_tr);
        oled2.drawStr(0, 35, msg.c_str());
        oled2.sendBuffer();
    }
}

void loadSchedules()
{
    File file = SPIFFS.open("/schedules.json", FILE_READ);
    if (!file)
    {
        logError("Failed to open schedules.json for reading.");
        return;
    }
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, file);
    if (error)
    {
        logError("Failed to parse schedules.json.");
        file.close();
        return;
    }
    file.close();

    dailyScheduleCount = 0;
    JsonArray arr = doc.as<JsonArray>();
    for (JsonObject obj : arr)
    {
        if (dailyScheduleCount < MAX_DAILY_SCHEDULES)
        {
            dailySchedules[dailyScheduleCount++] = {
                obj["drum"].as<int>(),
                obj["hour"].as<int>(),
                obj["minute"].as<int>(),
                obj["pills"].as<int>(),
                obj["executed"].as<bool>()};
        }
    }
    logInfo("Loaded " + String(dailyScheduleCount) + " daily schedules.");
}

void saveSchedules()
{
    File file = SPIFFS.open("/schedules.json", FILE_WRITE);
    if (!file)
    {
        logError("Failed to open schedules.json for writing.");
        return;
    }
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (int i = 0; i < dailyScheduleCount; i++)
    {
        JsonObject obj = arr.add<JsonObject>();
        obj["drum"] = dailySchedules[i].drum;
        obj["hour"] = dailySchedules[i].hour;
        obj["minute"] = dailySchedules[i].minute;
        obj["pills"] = dailySchedules[i].pills;
        obj["executed"] = dailySchedules[i].executed_today;
    }
    if (serializeJson(doc, file) == 0)
    {
        logError("Failed to write to schedules.json.");
    }
    file.close();
}

void saveSlotMap()
{
    File file = SPIFFS.open("/slotMap.txt", FILE_WRITE);
    if (!file)
    {
        logError("Failed to open slotMap.txt for writing.");
        return;
    }
    for (int i = 0; i < slotMapCount; i++)
    {
        file.println("Drum" + String(slotMap[i].drum) + ", Slot" + String(slotMap[i].slot) + ", " + slotMap[i].pillName);
    }
    file.close();
    logInfo("Slot map file updated.");
}

void loadSlotMap()
{
    slotMapCount = 0;
    File file = SPIFFS.open("/slotMap.txt", FILE_READ);
    if (!file)
    {
        logError("Failed to open slotMap.txt");
        return;
    }
    while (file.available() && slotMapCount < MAX_SLOTS)
    {
        String line = file.readStringUntil('\n');
        line.trim();
        if (line.length() == 0)
            continue;

        int firstComma = line.indexOf(',');
        int secondComma = line.indexOf(',', firstComma + 1);
        if (firstComma > 0 && secondComma > 0)
        {
            int drum = line.substring(line.indexOf("Drum") + 4, firstComma).toInt();
            int slot = line.substring(line.indexOf("Slot") + 4, secondComma).toInt();
            String pillName = line.substring(secondComma + 2); // +2 to skip ", "

            if (drum > 0 && slot > 0 && pillName.length() > 0)
            {
                slotMap[slotMapCount++] = {drum, slot, pillName};
            }
        }
    }
    file.close();
    logInfo("Loaded " + String(slotMapCount) + " slot map entries.");

    // After loading, check if a previously empty drum has been refilled
    for (int d = 1; d <= 2; d++)
    {
        if (drumIsEffectivelyEmpty[d - 1])
        {
            int currentSlot = (d == 1) ? currentSlotDrum1 : currentSlotDrum2;
            String pill = getPillName(d, currentSlot);
            if (pill != "Empty" && pill != "Ready to insert")
            {
                logInfo("Drum " + String(d) + " has been refilled. Resuming schedule.");
                drumIsEffectivelyEmpty[d - 1] = false;
            }
        }
    }
    updateOledsWithNextSchedule();
}

void updateSlotMapEntry(int drum, int slot, String pillName)
{
    bool entryExists = false;
    for (int i = 0; i < slotMapCount; i++)
    {
        if (slotMap[i].drum == drum && slotMap[i].slot == slot)
        {
            slotMap[i].pillName = pillName;
            entryExists = true;
            break;
        }
    }
    if (!entryExists && slotMapCount < MAX_SLOTS)
    {
        slotMap[slotMapCount++] = {drum, slot, pillName};
    }

    saveSlotMap(); // Save changes to file
    loadSlotMap(); // Reload map and update OLEDs
}

String getPillName(int drum, int slot)
{
    for (int i = 0; i < slotMapCount; i++)
    {
        if (slotMap[i].drum == drum && slotMap[i].slot == slot)
        {
            return slotMap[i].pillName;
        }
    }
    return "Ready to insert"; // Default for unconfigured slots
}

void logEvent(String eventMessage, bool updateLastAction)
{
    DateTime now = getRTCTime();
    char timestamp[32];
    snprintf(timestamp, sizeof(timestamp), "[%04d-%02d-%02d %02d:%02d:%02d]", now.year(), now.month(), now.day(), now.hour(), now.minute(), now.second());
    String logLine = String(timestamp) + " " + eventMessage;
    Serial.println(logLine);

    if (updateLastAction)
    {
        lastAction = {String(timestamp), eventMessage};
    }

    File logFile = SPIFFS.open("/log.txt", FILE_APPEND);
    if (logFile)
    {
        logFile.println(logLine);
        logFile.close();
    }
    else
    {
        logError("Failed to write to log.txt");
    }
}

void startBuzzerGradual()
{
    buzzerActive = true;
    buzzerStart = millis();
    lastToneStep = millis();
    currentFreq = 500;
    tone(buzzerPin, currentFreq);
}

void stopBuzzer()
{
    buzzerActive = false;
    noTone(buzzerPin);
}

// Helper to append one history item JSON object to an output string
static void appendHistoryItemJson(String &out, const String &timestampRaw, const String &message, bool &first)
{
    // Convert "YYYY-MM-DD HH:MM:SS" to ISO-like "YYYY-MM-DDTHH:MM:SS"
    String isoTs = timestampRaw;
    isoTs.replace(' ', 'T');

    String event = "";
    String medicine = "";
    int drum = -1;
    int slot = -1;
    String details = "";

    if (message.startsWith("MISSED: ")) {
        event = "MISSED";
        int fromIdx = message.indexOf(" from Drum ");
        if (fromIdx > 0) {
            medicine = message.substring(8, fromIdx);
            drum = message.substring(fromIdx + 11).toInt();
        } else {
            medicine = message.substring(8);
        }
    } else if (message.startsWith("TAKEN: ")) {
        event = "TAKEN";
        int fromIdx = message.indexOf(" from Drum ");
        if (fromIdx > 0) {
            medicine = message.substring(8, fromIdx);
            drum = message.substring(fromIdx + 11).toInt();
        } else {
            medicine = message.substring(8);
        }
    } else if (message.startsWith("DISPENSED: ")) {
        event = "DISPENSED";
        int fromIdx = message.indexOf(" from Drum ");
        int slotIdx = message.indexOf(" Slot ");
        if (fromIdx > 0) {
            medicine = message.substring(11, fromIdx);
            if (slotIdx > 0) {
                drum = message.substring(fromIdx + 11, slotIdx).toInt();
                slot = message.substring(slotIdx + 6).toInt();
            } else {
                drum = message.substring(fromIdx + 11).toInt();
            }
        } else {
            medicine = message.substring(11);
        }
    } else if (message.startsWith("Removed medicine")) {
        event = "Removed";
        // Example: "Removed medicine from Drum X, Slot Y"
        int drumIdx = message.indexOf("Drum ");
        int commaIdx = message.indexOf(", Slot ");
        if (drumIdx > 0) {
            if (commaIdx > drumIdx) {
                drum = message.substring(drumIdx + 5, commaIdx).toInt();
                slot = message.substring(commaIdx + 7).toInt();
            } else {
                drum = message.substring(drumIdx + 5).toInt();
            }
        }
        details = message;
    } else if (message.startsWith("Drums logically reset")) {
        event = "Reset";
        details = message;
    } else if (message.startsWith("Daily schedules updated")) {
        event = "SchedulesUpdated";
        details = message;
    } else {
        // Fallback: use entire message as event
        event = message;
    }

    JsonDocument itemDoc;
    itemDoc["timestamp"] = isoTs;
    itemDoc["event"] = event;
    if (medicine.length() > 0) itemDoc["medicine"] = medicine; else itemDoc["medicine"] = "";
    if (drum >= 0) itemDoc["drum"] = drum; else itemDoc["drum"] = nullptr;
    if (slot >= 0) itemDoc["slot"] = slot; else itemDoc["slot"] = nullptr;
    if (details.length() > 0) itemDoc["details"] = details; else itemDoc["details"] = "";

    String itemJson;
    serializeJson(itemDoc, itemJson);
    if (!first) {
        out += ",";
    } else {
        first = false;
    }
    out += itemJson;
}

void showTakenOnOled(int drum, const String &pill)
{
    String line1 = "Dose Confirmed!";
    String line2 = pill.substring(0, 15);
    bool displaySuccess = false;
    int retryCount = 0;

    while (!displaySuccess && retryCount < 3)
    {
        if (drum == 1)
        {
            if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(1000)) == pdTRUE)
            {
                oled1.clearBuffer();
                oled1.setFont(u8g2_font_ncenB08_tr);
                oled1.drawStr(0, 20, line1.c_str());
                oled1.drawStr(0, 40, line2.c_str());
                oled1.sendBuffer();
                xSemaphoreGive(i2c_mutex);
                displaySuccess = true;
            }
        }
        else
        {
            if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(1000)) == pdTRUE)
            {
                oled2.clearBuffer();
                oled2.setFont(u8g2_font_ncenB08_tr);
                oled2.drawStr(0, 20, line1.c_str());
                oled2.drawStr(0, 40, line2.c_str());
                oled2.sendBuffer();
                xSemaphoreGive(i2c_mutex);
                displaySuccess = true;
            }
        }

        if (!displaySuccess)
        {
            retryCount++;
            delay(50); // Short delay before retry
        }
    }

    if (!displaySuccess)
    {
        logError("Failed to update OLED " + String(drum) + " after multiple attempts");
    }
}

String getPillNameForSlot(int drum, int slot)
{
    return getPillName(drum, slot);
}

bool updateOledDisplay(int drum, const String &line1, const String &line2)
{
    String newContent = line1 + "|" + line2;
    String *lastContent = (drum == 1) ? &lastOled1Content : &lastOled2Content;
    
    // Only update if content has changed
    if (newContent == *lastContent) {
        return true; // No update needed, but not an error
    }
    
    bool success = false;
    int retryCount = 0;
    
    while (!success && retryCount < 3) {
        if (drum == 1) {
            if (xSemaphoreTake(i2c_mutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
                oled1.clearBuffer();
                oled1.setFont(u8g2_font_ncenB08_tr);
                oled1.drawStr(0, 20, line1.c_str());
                oled1.drawStr(0, 40, line2.c_str());
                oled1.sendBuffer();
                xSemaphoreGive(i2c_mutex);
                success = true;
            }
        } else {
            oled2.clearBuffer();
            oled2.setFont(u8g2_font_ncenB08_tr);
            oled2.drawStr(0, 20, line1.c_str());
            oled2.drawStr(0, 40, line2.c_str());
            oled2.sendBuffer();
            success = true;
        }
        
        if (!success) {
            retryCount++;
            delay(50);
        }
    }
    
    if (success) {
        *lastContent = newContent;
    } else {
        logError("Failed to update OLED " + String(drum) + " after multiple attempts");
    }
    
    return success;
}

void showErrorOnOled(int drum, const String &errorMsg)
{
    updateOledDisplay(drum, "Error:", errorMsg.substring(0, 15));
}

void showEmptyOnOled(int drum)
{
    drumIsEffectivelyEmpty[drum - 1] = true;
    String line1 = "Drum " + String(drum) + " is empty";
    String line2 = "Please refill.";

    // Set a timeout for the empty display (10 minutes)
    emptyDisplayUntil[drum - 1] = millis() + 600000;

    updateOledDisplay(drum, line1, line2);
}

void updateOledsWithNextSchedule()
{
    if (takenDisplayUntil != 0 && millis() < takenDisplayUntil)
        return;
    DateTime now = getRTCTime();
    
    // Format current time as HH:MM:SS
    String currentTime = "";
    if (now.hour() < 10) currentTime += "0";
    currentTime += String(now.hour()) + ":";
    if (now.minute() < 10) currentTime += "0";
    currentTime += String(now.minute()) + ":";
    if (now.second() < 10) currentTime += "0";
    currentTime += String(now.second());

    for (int d = 1; d <= 2; d++)
    {
        // Check if we're still in the empty display timeout period
        if (drumIsEffectivelyEmpty[d - 1] && emptyDisplayUntil[d - 1] > millis())
        {
            // Keep showing the empty message
            continue;
        }
        else if (drumIsEffectivelyEmpty[d - 1])
        {
            // Empty display timeout has expired, show the next schedule anyway
            // but keep drumIsEffectivelyEmpty true until refilled
        }

        int nextHour = -1, nextMin = -1;
        bool scheduleFound = false;

        // Find next schedule for today
        for (int i = 0; i < dailyScheduleCount; i++)
        {
            if (dailySchedules[i].drum == d && !dailySchedules[i].executed_today)
            {
                if (dailySchedules[i].hour > now.hour() || (dailySchedules[i].hour == now.hour() && dailySchedules[i].minute > now.minute()))
                {
                    if (!scheduleFound || dailySchedules[i].hour < nextHour || (dailySchedules[i].hour == nextHour && dailySchedules[i].minute < nextMin))
                    {
                        nextHour = dailySchedules[i].hour;
                        nextMin = dailySchedules[i].minute;
                        scheduleFound = true;
                    }
                }
            }
        }

        // If no more for today, find first schedule for tomorrow
        if (!scheduleFound)
        {
            for (int i = 0; i < dailyScheduleCount; i++)
            {
                if (dailySchedules[i].drum == d)
                {
                    if (!scheduleFound || dailySchedules[i].hour < nextHour || (dailySchedules[i].hour == nextHour && dailySchedules[i].minute < nextMin))
                    {
                        nextHour = dailySchedules[i].hour;
                        nextMin = dailySchedules[i].minute;
                        scheduleFound = true;
                    }
                }
            }
        }

        String line2 = "None";
        if (scheduleFound)
        {
            char timeBuf[6];
            snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", nextHour, nextMin);
            line2 = String(timeBuf);
        }

        // Display current time and next schedule
        String line1 = "Time: " + currentTime;
        line2 = "Next: " + line2;

        // Use our helper function to update the display only if content has changed
        updateOledDisplay(d, line1, line2);
    }
}