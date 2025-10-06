// In-memory storage for medicines and schedules
let configuredMedicines = [];
let currentSchedules = [];
const MAX_SLOTS_PER_DRUM = 7;
let statusLoading = false; // prevent overlapping status refreshes

// Dashboard helper to refresh upcoming schedules
async function refreshUpcomingSchedules() {
  const schedulesEl = document.getElementById('upcomingSchedules');
  if (!schedulesEl) return;
  
  try {
    const res = await fetch('/api/upcoming-schedules');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    
    const schedules = await res.json();
    
    if (schedules.length === 0) {
      schedulesEl.innerHTML = '<div class="empty-list">No upcoming schedules found.</div>';
      return;
    }
    
    // Group schedules by day
    const today = schedules.filter(s => s.day === 0);
    const tomorrow = schedules.filter(s => s.day === 1);
    
    let html = '';
    
    if (today.length > 0) {
      html += '<h4 style="margin: 0 0 10px 0; color: #333;">Today</h4>';
      today.forEach(schedule => {
        html += `
          <div class="upcoming-schedule">
            <div class="upcoming-schedule-time">${schedule.time}</div>
            <div class="upcoming-schedule-medicine">
              ${schedule.medicine} (Drum ${schedule.drum})
              ${schedule.executed ? ' ✅' : ''}
            </div>
          </div>
        `;
      });
    }
    
    if (tomorrow.length > 0) {
      html += '<h4 style="margin: 15px 0 10px 0; color: #333;">Tomorrow</h4>';
      tomorrow.forEach(schedule => {
        html += `
          <div class="upcoming-schedule">
            <div class="upcoming-schedule-time">${schedule.time}</div>
            <div class="upcoming-schedule-medicine">
              ${schedule.medicine} (Drum ${schedule.drum})
            </div>
          </div>
        `;
      });
    }
    
    schedulesEl.innerHTML = html;
    
  } catch (e) {
    console.error('Error fetching upcoming schedules:', e);
    schedulesEl.innerHTML = '<div class="empty-list">Error loading schedules.</div>';
  }
}
async function refreshLogs() {
  const logsEl = document.getElementById('logs');
  const dict = (i18n[currentLang]?.dashboard) || i18n.en.dashboard;
  if (logsEl) {
    logsEl.textContent = dict.systemLogsLoading;
  }
  try {
    const res = await fetch('/logs');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (logsEl) {
      logsEl.textContent = text;
    }
  } catch (e) {
    if (logsEl) {
      logsEl.textContent = dict.offlineText + ': ' + (e && e.message ? e.message : '');
    }
  }
}
async function refreshLastAction() {
  const statusEl = document.getElementById('lastActionStatus');
  const dict = (i18n[currentLang]?.dashboard) || i18n.en.dashboard;
  if (statusEl) {
    statusEl.textContent = dict.recentActivityLoading;
  }
  try {
    const res = await fetch('/lastAction');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (statusEl) {
      const ts = data.timestamp ? new Date(String(data.timestamp).replace(' ', 'T')).toLocaleString() : '';
      const ev = data.event || '';
      statusEl.textContent = ts && ev ? `${ts} — ${ev}` : ev || ts || '';
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = dict.offlineText + ': ' + (e && e.message ? e.message : '');
    }
  }
}
function refreshSchedulesList() {
  const container = document.getElementById('schedulesList');
  if (!container) return;
  if (!Array.isArray(currentSchedules) || currentSchedules.length === 0) {
    container.innerHTML = '<div class="empty-list">No schedules added yet.</div>';
    return;
  }
  container.innerHTML = '';
  currentSchedules.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const main = document.createElement('div');
    main.className = 'list-item-main';
    const title = document.createElement('div');
    title.className = 'list-item-title';
    title.textContent = `${s.dateTime} - ${s.medicine.pillName} (Drum ${s.medicine.drum}, Slot ${s.medicine.slot})`;
    main.appendChild(title);
    item.appendChild(main);
    container.appendChild(item);
  });
}

// Tab switching functionality
function showTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(navTab => navTab.classList.remove('active'));
  document.getElementById(tabName).classList.add('active');
  document.querySelector(`.nav-tab[onclick="showTab('${tabName}')"]`).classList.add('active');
  if (tabName === 'medicine') {
    refreshMedicinesList();
  } else if (tabName === 'schedule') {
    updateScheduleMedicineOptions();
    updateScheduleAvailability();
  }
}

// Refresh the lists of configured medicines in the new UI
function refreshMedicinesList() {
  const medicinesByDrum = {
    1: configuredMedicines.filter(m => m.drum == 1).sort((a, b) => a.slot - b.slot),
    2: configuredMedicines.filter(m => m.drum == 2).sort((a, b) => a.slot - b.slot)
  };

  for (let drumNum = 1; drumNum <= 2; drumNum++) {
    const container = document.getElementById(`medicinesList${drumNum}`);
    const capacityEl = document.getElementById(`drum${drumNum}Capacity`);
    const countInput = document.getElementById(`addMedCount${drumNum}`);
    
    const drumMeds = medicinesByDrum[drumNum];
    const availableSlots = MAX_SLOTS_PER_DRUM - drumMeds.length;

    capacityEl.textContent = `(${availableSlots} of ${MAX_SLOTS_PER_DRUM} slots available)`;
    countInput.max = availableSlots;
    if (availableSlots === 0) {
        countInput.disabled = true;
        countInput.placeholder = "Drum is full";
    } else {
        countInput.disabled = false;
        countInput.placeholder = "Number of new medicines to add";
    }

    if (drumMeds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-list';
      const emptyKey = drumNum === 1 ? 'emptyDrum1' : 'emptyDrum2';
      const emptyText = (i18n[currentLang]?.medicine?.[emptyKey]) || `Drum ${drumNum} is empty.`;
      empty.textContent = emptyText;
      container.innerHTML = '';
      container.appendChild(empty);
      continue;
    }

    container.innerHTML = '';
    drumMeds.forEach(med => {
      const item = document.createElement('div');
      item.className = 'list-item';

      const main = document.createElement('div');
      main.className = 'list-item-main';

      const title = document.createElement('div');
      title.className = 'list-item-title';
      title.textContent = `Slot ${med.slot}: ${med.pillName}`;
      main.appendChild(title);

      const action = document.createElement('div');
      action.className = 'list-item-action';
      action.title = 'Remove this medicine';
      action.textContent = '🗑️';
      action.addEventListener('click', () => removeMedicine(med.drum, med.slot));

      item.appendChild(main);
      item.appendChild(action);
      container.appendChild(item);
    });
  }
}

// Dynamically generate input fields for new medicines
function generateMedicineInputs(drumNum, count) {
  const container = document.getElementById(`newMedicinesContainer${drumNum}`);
  const countInput = document.getElementById(`addMedCount${drumNum}`);
  const max = parseInt(countInput.max, 10);

  if (count > max) {
    alert(`You can only add up to ${max} more medicines to this drum.`);
    countInput.value = max;
    count = max;
  }

  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const inputGroup = document.createElement('div');
    inputGroup.className = 'form-group';
    inputGroup.innerHTML = `
      <label class="form-label">Medicine Name #${i + 1}</label>
      <input type="text" class="new-medicine-name" data-drum="${drumNum}" placeholder="e.g., Aspirin 100mg">
    `;
    container.appendChild(inputGroup);
  }
}

// Save the newly added medicines for a specific drum
async function saveMedicines(drumNum) {
  const inputs = document.querySelectorAll(`#newMedicinesContainer${drumNum} .new-medicine-name`);
  const newMeds = [];
  let allNamesValid = true;

  inputs.forEach(input => {
    const pillName = input.value.trim();
    if (!pillName) {
      allNamesValid = false;
    }
    newMeds.push({ pillName });
  });

  if (!allNamesValid) {
    return alert('Please provide a name for all new medicines.');
  }

  if (newMeds.length === 0) {
    return alert('No new medicines to save.');
  }

  try {
    const formData = new FormData();
    formData.append('data', JSON.stringify({ drum: drumNum, medicines: newMeds }));

    const res = await fetch('/addMultipleSlotMapEntries', {
      method: 'POST',
      body: formData
    });

    const result = await res.text();

    if (res.ok) {
      alert(result); // Show success message from server
      // Clear the input fields
      document.getElementById(`addMedCount${drumNum}`).value = '';
      document.getElementById(`newMedicinesContainer${drumNum}`).innerHTML = '';
      // Reload all data to reflect changes
      await loadAndDisplayMedicines();
    } else {
      alert(`Error: ${result}`); // Show error message from server
    }
  } catch (err) {
    alert('Error saving new medicines.');
    console.error('Save medicines error:', err);
  }
}

// Remove a single medicine entry
async function removeMedicine(drum, slot) {
  if (!confirm(`Are you sure you want to remove the medicine from Drum ${drum}, Slot ${slot}? This may affect your schedule.`)) {
    return;
  }

  try {
    let formData = new FormData();
    formData.append("drum", drum);
    formData.append("slot", slot);

    const res = await fetch('/removeSlotMapEntry', { method: 'POST', body: formData });
    const result = await res.text();
    alert(result);

    if (res.ok) {
      await loadAndDisplayMedicines();
    }
  } catch (err) {
    alert('Error removing medicine.');
    console.error('Remove medicine error:', err);
  }
}

// Update medicine dropdown in the schedule tab
function updateScheduleMedicineOptions() {
  const select = document.getElementById('scheduleMedicine');
  if (!select) return;
  select.innerHTML = '<option value="">Select a medicine</option>';
  const sortedMeds = [...configuredMedicines].sort((a,b) => {
    if (a.drum < b.drum) return -1;
    if (a.drum > b.drum) return 1;
    return a.slot - b.slot;
  });
  sortedMeds.forEach(medicine => {
    const option = document.createElement('option');
    option.value = `${medicine.drum},${medicine.slot}`;
    option.textContent = `${medicine.pillName} (Drum ${medicine.drum}, Slot ${medicine.slot})`;
    select.appendChild(option);
  });
  // Update availability state after options are set
  try { updateScheduleAvailability(); } catch (_) {}
}

// Fetch medicines from the server and update the UI
async function loadAndDisplayMedicines() {
  try {
    const response = await fetch('/getSlotMap');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    configuredMedicines = await response.json();
    refreshMedicinesList();
    updateScheduleMedicineOptions();
    try { updateScheduleAvailability(); } catch (_) {}
    try { refreshUpcomingSchedules(); } catch (_) {}
  } catch (error) {
    console.error('Error fetching medication status:', error);
    const errText = (i18n[currentLang]?.medicine?.errorLoadingData) || 'Error loading data.';
    document.getElementById('medicinesList1').innerHTML = `<div class="empty-list" style="color: red;">${errText}</div>`;
    document.getElementById('medicinesList2').innerHTML = `<div class="empty-list" style="color: red;">${errText}</div>`;
  }
}

// Fetches and updates the main system status
async function refreshStatus() {
  if (statusLoading) return;
  statusLoading = true;
  try {
    const res = await fetch('/status');
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    const data = await res.json();
    document.getElementById('currentTime').textContent = data.time;
    document.getElementById('drum1Status').textContent = `Slot ${data.slotDrum1}`;
    document.getElementById('drum2Status').textContent = `Slot ${data.slotDrum2}`;
    document.getElementById('wifiStatus').textContent = data.wifi;
  } catch (error) {
    console.error('Error refreshing status:', error);
    document.getElementById('currentTime').textContent = (i18n[currentLang]?.dashboard?.errorText) || 'Error';
    document.getElementById('drum1Status').textContent = (i18n[currentLang]?.dashboard?.errorText) || 'Error';
    document.getElementById('drum2Status').textContent = (i18n[currentLang]?.dashboard?.errorText) || 'Error';
    document.getElementById('wifiStatus').textContent = (i18n[currentLang]?.dashboard?.offlineText) || 'Offline';
  } finally {
    statusLoading = false;
  }
}



if (!window.__appIntervalsInitialized) {
        window.__appIntervalsInitialized = true;
        setInterval(refreshStatus, 5000);
        setInterval(refreshLogs, 10000);
        setInterval(refreshLastAction, 5000);
        setInterval(refreshUpcomingSchedules, 30000);
    }

    // Initial load
    window.addEventListener('DOMContentLoaded', () => {
      applyLanguage(localStorage.getItem(LANG_KEY) || 'en');
      initializeApp();
    });

// Minimal i18n dictionary to avoid undefined errors and support core UI strings
const i18n = {
  en: {
    dashboard: {
      systemLogsLoading: "Loading system logs...",
      recentActivityLoading: "Loading recent activity...",
      errorText: "Error",
      offlineText: "Offline"
    },
    medicine: {
      emptyDrum1: "Drum 1 is empty.",
      emptyDrum2: "Drum 2 is empty.",
      errorLoadingData: "Error loading data."
    },
    common: {
      selectMedicine: "Select a medicine"
    },
    history: {
      error: {
        loadFailedTitle: "Could not load history",
        loadFailedSubtitle: "Failed to connect to the dispenser. Please check the connection."
      },
      loading: {
        loadingData: "Loading history data..."
      },
      empty: {
        title: "No history records found",
        subtitle: "History will appear here once the dispenser starts operating.",
        noMatch: "No records match your filters"
      }
    }
  },
  ar: {
    dashboard: {
      systemLogsLoading: "جارٍ تحميل سجلات النظام...",
      recentActivityLoading: "جارٍ تحميل النشاط الأخير...",
      errorText: "خطأ",
      offlineText: "غير متصل"
    },
    medicine: {
      emptyDrum1: "الأسطوانة 1 فارغة.",
      emptyDrum2: "الأسطوانة 2 فارغة.",
      errorLoadingData: "خطأ في تحميل البيانات."
    },
    common: {
      selectMedicine: "اختر الدواء"
    },
    history: {
      error: {
        loadFailedTitle: "تعذر تحميل السجل",
        loadFailedSubtitle: "فشل الاتصال بجهاز الصرف. يرجى التحقق من الاتصال."
      },
      loading: {
        loadingData: "جارٍ تحميل بيانات السجل..."
      },
      empty: {
        title: "لا توجد سجلات في السجل",
        subtitle: "سيظهر السجل هنا بمجرد بدء عمل جهاز الصرف.",
        noMatch: "لا توجد سجلات مطابقة لمرشحاتك"
      }
    }
  }
};

// Language keys and state
const LANG_KEY = 'ui_lang';
const RTL_KEY = 'ui_dir_rtl';
let currentLang = localStorage.getItem(LANG_KEY) || 'en';
let isRTL = localStorage.getItem(RTL_KEY) === 'true';

// Initial app bootstrap: perform first refreshes and bind schedule frequency toggles
function initializeApp() {
  if (window.__appInitialized) return;
  window.__appInitialized = true;

  try { refreshStatus(); } catch (_) {}
  try { refreshLogs(); } catch (_) {}
  try { refreshLastAction(); } catch (_) {}
  try { loadAndDisplayMedicines(); } catch (_) {}
  try { refreshSchedulesList(); } catch (_) {}
  try { refreshUpcomingSchedules(); } catch (_) {}

  // Event listeners for drum 1 schedule frequency
  const scheduleFrequency1 = document.getElementById('scheduleFrequency1');
  const onceADayOptions1 = document.getElementById('onceADayOptions1');
  const twiceADayOptions1 = document.getElementById('twiceADayOptions1');
  if (scheduleFrequency1 && onceADayOptions1 && twiceADayOptions1) {
    scheduleFrequency1.addEventListener('change', function() {
      if (this.value === 'once') {
        onceADayOptions1.style.display = 'block';
        twiceADayOptions1.style.display = 'none';
      } else {
        onceADayOptions1.style.display = 'none';
        twiceADayOptions1.style.display = 'block';
      }
    });
  }

  // Event listeners for drum 2 schedule frequency
  const scheduleFrequency2 = document.getElementById('scheduleFrequency2');
  const onceADayOptions2 = document.getElementById('onceADayOptions2');
  const twiceADayOptions2 = document.getElementById('twiceADayOptions2');
  if (scheduleFrequency2 && onceADayOptions2 && twiceADayOptions2) {
    scheduleFrequency2.addEventListener('change', function() {
      if (this.value === 'once') {
        onceADayOptions2.style.display = 'block';
        twiceADayOptions2.style.display = 'none';
      } else {
        onceADayOptions2.style.display = 'none';
        twiceADayOptions2.style.display = 'block';
      }
    });
  }
}

// Clear drums API call with basic error handling
async function clearDrums() {
  try {
    let res = await fetch('/clearDrums', { method: 'POST' });
    alert(await res.text());
    try { refreshStatus(); } catch (_) {}
  } catch (err) {
    alert('Error clearing drums.');
    console.error('clearDrums error:', err);
  }
}

function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem(LANG_KEY, currentLang);
  const dict = i18n[currentLang] || i18n.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const parts = key.split('.');
    let value = dict;
    for (const p of parts) value = value && value[p];
    if (typeof value === 'string') el.textContent = value;
  });
  // Translate placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const parts = key.split('.');
    let value = dict;
    for (const p of parts) value = value && value[p];
    if (typeof value === 'string') el.setAttribute('placeholder', value);
  });
  // Update toggle button label
  const btn = document.getElementById('langToggleBtn');
  if (btn) btn.textContent = currentLang === 'en' ? 'العربية' : 'English';
  // Set RTL according to language
  setRTL(currentLang === 'ar');
  // Refresh dynamic medicine section texts (capacity, placeholders)
  try { refreshMedicinesList(); } catch (_) {}
  // Notify page-specific hook to re-render dynamic i18n content (e.g., history table)
  try { if (typeof window.onLanguageChanged === 'function') window.onLanguageChanged(currentLang); } catch (_) {}
}

function toggleLanguage() {
  const next = currentLang === 'en' ? 'ar' : 'en';
  applyLanguage(next);
}

function setRTL(enable) {
  isRTL = !!enable;
  localStorage.setItem(RTL_KEY, String(isRTL));
  const html = document.documentElement;
  html.setAttribute('dir', isRTL ? 'rtl' : 'ltr');
  html.setAttribute('lang', currentLang);
  document.body.classList.toggle('rtl', isRTL);
}

// Use i18n strings for dashboard error/offline states
// In refreshStatus catch

// Use i18n for medicine error loading messages
// In loadAndDisplayMedicines catch
// document.getElementById('medicinesList1').innerHTML = '<div class="empty-list" style="color: red;">Error loading data.</div>';
// document.getElementById('medicinesList2').innerHTML = '<div class="empty-list" style="color: red;">Error loading data.</div>';




// Use i18n for medicine error loading messages
// In loadAndDisplayMedicines catch
// document.getElementById('medicinesList1').innerHTML = '<div class="empty-list" style="color: red;">Error loading data.</div>';
// document.getElementById('medicinesList2').innerHTML = '<div class="empty-list" style="color: red;">Error loading data.</div>';


    async function manualDispense(drum) {
      let pillsInput = prompt("How many pills to dispense?", 1);
      if (pillsInput === null) return;
      const pills = parseInt(String(pillsInput).trim(), 10);
      if (!Number.isFinite(pills) || pills <= 0) {
        alert('Please enter a valid positive number of pills.');
        return;
      }
      try {
        let formData = new FormData();
        formData.append("drum", drum);
        formData.append("pills", String(pills));
        let res = await fetch('/manualDispense', { method: "POST", body: formData });
        const text = await res.text();
        if (!res.ok) {
          alert(`Error: ${text}`);
        } else {
          alert(text);
        }
      } catch (err) {
        alert('Error performing manual dispense.');
        console.error('manualDispense error:', err);
      } finally {
        try { refreshLogs(); } catch (_) {}
      }
    }

    async function saveSchedules() {
        if (!confirm('Saving new schedules will perform a LOGICAL reset. You will be prompted to clear the drums and must then refill them starting from Slot 1. Are you sure you want to continue?')) {
            return;
        }

        const frequency1 = document.getElementById('scheduleFrequency1').value;
        const frequency2 = document.getElementById('scheduleFrequency2').value;

        let scheduleData = {
            drum1: { frequency: frequency1, times: [] },
            drum2: { frequency: frequency2, times: [] }
        };

        const isValidTime = (t) => {
            if (typeof t !== 'string') return false;
            const m = t.match(/^\d{2}:\d{2}$/);
            if (!m) return false;
            const [hh, mm] = t.split(':').map(n => parseInt(n, 10));
            return Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
        };

        if (frequency1 === 'once') {
            const time1 = document.getElementById('onceDailyTime1').value;
            if (!time1) return alert('Please set a time for Drum 1.');
            if (!isValidTime(time1)) return alert('Please enter a valid time (HH:MM) for Drum 1.');
            scheduleData.drum1.times.push(time1);
        } else {
            const time1_1 = document.getElementById('twiceDailyTime1_1').value;
            const time1_2 = document.getElementById('twiceDailyTime1_2').value;
            if (!time1_1 || !time1_2) return alert('Please set both times for Drum 1.');
            if (!isValidTime(time1_1) || !isValidTime(time1_2)) return alert('Please enter valid times (HH:MM) for Drum 1.');
            if (time1_1 === time1_2) return alert('Drum 1 times must be different.');
            scheduleData.drum1.times.push(time1_1, time1_2);
        }

        if (frequency2 === 'once') {
            const time2 = document.getElementById('onceDailyTime2').value;
            if (!time2) return alert('Please set a time for Drum 2.');
            if (!isValidTime(time2)) return alert('Please enter a valid time (HH:MM) for Drum 2.');
            scheduleData.drum2.times.push(time2);
        } else {
            const time2_1 = document.getElementById('twiceDailyTime2_1').value;
            const time2_2 = document.getElementById('twiceDailyTime2_2').value;
            if (!time2_1 || !time2_2) return alert('Please set both times for Drum 2.');
            if (!isValidTime(time2_1) || !isValidTime(time2_2)) return alert('Please enter valid times (HH:MM) for Drum 2.');
            if (time2_1 === time2_2) return alert('Drum 2 times must be different.');
            scheduleData.drum2.times.push(time2_1, time2_2);
        }

        let formData = new FormData();
        formData.append("data", JSON.stringify(scheduleData));

        try {
            let res = await fetch('/setDailySchedules', { method: "POST", body: formData });
            const text = await res.text();
            if (!res.ok) {
                alert(`Error: ${text}`);
            } else {
                alert(text);
                await clearDrums();
            }
        } catch (err) {
            alert('Error saving schedules.');
            console.error('saveSchedules error:', err);
        }
    }