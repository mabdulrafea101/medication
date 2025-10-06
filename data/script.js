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
    
    // Get translations
    const dict = i18n[currentLang] || i18n.en;
    const scheduleDict = dict.schedule || i18n.en.schedule;
    
    if (schedules.length === 0) {
      schedulesEl.innerHTML = `<div class="empty-list">${scheduleDict.noUpcomingSchedules}</div>`;
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
    const dict = i18n[currentLang] || i18n.en;
    const scheduleDict = dict.schedule || i18n.en.schedule;
    schedulesEl.innerHTML = `<div class="empty-list">${scheduleDict.errorLoadingSchedules}</div>`;
  }
}

async function refreshDispenserStatus() {
  const statusEl = document.getElementById('dispenserStatus');
  const manualStatusEl = document.getElementById('manualDispenserStatus');
  const scheduleStatusEl = document.getElementById('scheduleDispenserStatus');
  
  try {
    const res = await fetch('/api/dispenser-status');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    
    const data = await res.json();
    
    // Get translations
    const dict = i18n[currentLang] || i18n.en;
    const dispenserDict = dict.dispenser || i18n.en.dispenser;
    
    // Generate dashboard status HTML
    let dashboardHtml = '';
    
    // Check for any empty drums and show alert
    const emptyDrums = data.drums.filter(drum => drum.isEmpty || drum.fillPercentage <= 20);
    if (emptyDrums.length > 0) {
      dashboardHtml += '<div class="dispenser-alert">';
      dashboardHtml += '<span class="alert-icon">⚠️</span>';
      dashboardHtml += 'Action Required: ';
      emptyDrums.forEach((drum, index) => {
        if (index > 0) dashboardHtml += ', ';
        dashboardHtml += `${dispenserDict.drum} ${drum.drum}`;
        if (drum.isEmpty) {
          dashboardHtml += ` ${dispenserDict.isEmpty}`;
        } else {
          dashboardHtml += ` ${dispenserDict.isLow}`;
        }
      });
      dashboardHtml += `. ${dispenserDict.pleaseRefill}`;
      dashboardHtml += '</div>';
    }
    
    // Show status for each drum
    data.drums.forEach(drum => {
      let statusClass = 'good';
      if (drum.isEmpty || drum.fillPercentage === 0) {
        statusClass = 'empty';
      } else if (drum.fillPercentage <= 20) {
        statusClass = 'low';
      }
      
      dashboardHtml += `
        <div class="drum-status ${statusClass}">
          <div class="drum-info">
            <div class="drum-title">${dispenserDict.drum} ${drum.drum}</div>
            <div class="drum-details">
              ${dispenserDict.currentSlot}: ${drum.currentSlot} | 
              ${7 - drum.emptySlots} ${dispenserDict.slotsOf} 7 ${dispenserDict.slotsFilled}
            </div>
          </div>
          <div class="fill-indicator">
            <div class="fill-percentage">${drum.fillPercentage}%</div>
            <div class="fill-bar">
              <div class="fill-progress" style="width: ${drum.fillPercentage}%"></div>
            </div>
          </div>
        </div>
      `;
    });
    
    // Update dashboard status
    if (statusEl) {
      statusEl.innerHTML = dashboardHtml;
    }
    
    // Generate manual tab status HTML (simplified version)
    let manualHtml = '';
    if (emptyDrums.length > 0) {
      manualHtml += '<div class="dispenser-alert" style="margin-bottom: 1rem;">';
      manualHtml += '<span class="alert-icon">⚠️</span>';
      manualHtml += '<strong>Warning:</strong> ';
      emptyDrums.forEach((drum, index) => {
        if (index > 0) manualHtml += ', ';
        manualHtml += `${dispenserDict.drum} ${drum.drum}`;
        if (drum.isEmpty) {
          manualHtml += ` ${dispenserDict.isEmpty}`;
        } else {
          manualHtml += ` ${dispenserDict.isLow}`;
        }
      });
      manualHtml += '. Manual dispensing may not work properly.';
      manualHtml += '</div>';
    } else {
      manualHtml += '<div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(40, 167, 69, 0.1); border-radius: 8px; border-left: 4px solid #28a745; color: #155724;">';
      manualHtml += `<span style="font-weight: 500;">✅ ${dispenserDict.readyForDispensing}</span>`;
      manualHtml += '</div>';
    }
    
    // Update manual tab status
    if (manualStatusEl) {
      manualStatusEl.innerHTML = manualHtml;
    }
    
    // Generate schedule tab status HTML and apply UI restrictions
    let scheduleHtml = '';
    const drum1Empty = data.drums.find(d => d.drum === 1)?.isEmpty || false;
    const drum2Empty = data.drums.find(d => d.drum === 2)?.isEmpty || false;
    
    if (emptyDrums.length > 0) {
      scheduleHtml += '<div class="drum-disabled-notice">';
      scheduleHtml += '<span class="error-icon">🚫</span>';
      scheduleHtml += '<strong>Schedule Restrictions:</strong> ';
      emptyDrums.forEach((drum, index) => {
        if (index > 0) scheduleHtml += ', ';
        scheduleHtml += `${dispenserDict.drum} ${drum.drum}`;
        if (drum.isEmpty) {
          scheduleHtml += ` ${dispenserDict.isEmpty} ${dispenserDict.cannotBeScheduled}`;
        } else {
          scheduleHtml += ` ${dispenserDict.isLow}`;
        }
      });
      scheduleHtml += `. ${dispenserDict.pleaseRefillSchedule}`;
      scheduleHtml += '</div>';
    } else {
      scheduleHtml += '<div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(40, 167, 69, 0.1); border-radius: 8px; border-left: 4px solid #28a745; color: #155724;">';
      scheduleHtml += '<span style="font-weight: 500;">✅ Both drums are ready for scheduling</span>';
      scheduleHtml += '</div>';
    }
    
    // Update schedule tab status
    if (scheduleStatusEl) {
      scheduleStatusEl.innerHTML = scheduleHtml;
    }
    
    // Apply UI restrictions based on drum status
    applyUIRestrictions(drum1Empty, drum2Empty);
    
  } catch (e) {
    console.error('Error fetching dispenser status:', e);
    const dict = i18n[currentLang] || i18n.en;
    const errorMsg = `<div class="dispenser-status-loading">${dict.dashboard?.dispenserStatusError || 'Error loading dispenser status.'}</div>`;
    if (statusEl) statusEl.innerHTML = errorMsg;
    if (manualStatusEl) manualStatusEl.innerHTML = errorMsg;
    if (scheduleStatusEl) scheduleStatusEl.innerHTML = errorMsg;
  }
}

// Apply UI restrictions based on drum status and mode conflicts
function applyUIRestrictions(drum1Empty, drum2Empty) {
  // Get translations
  const dict = i18n[currentLang] || i18n.en;
  const dispenserDict = dict.dispenser || i18n.en.dispenser;
  
  // Get all drum 1 controls
  const drum1Controls = [
    document.getElementById('scheduleFrequency1'),
    document.getElementById('onceDailyTime1'),
    document.getElementById('twiceDailyTime1_1'),
    document.getElementById('twiceDailyTime1_2')
  ].filter(el => el);
  
  // Get all drum 2 controls
  const drum2Controls = [
    document.getElementById('scheduleFrequency2'),
    document.getElementById('onceDailyTime2'),
    document.getElementById('twiceDailyTime2_1'),
    document.getElementById('twiceDailyTime2_2')
  ].filter(el => el);
  
  // Get manual dispense buttons
  const manualBtn1 = document.querySelector('button[onclick="manualDispense(1)"]');
  const manualBtn2 = document.querySelector('button[onclick="manualDispense(2)"]');
  
  // Get save schedules button
  const saveSchedulesBtn = document.querySelector('button[onclick="saveSchedules()"]');
  
  // Disable drum 1 controls if drum 1 is empty
  drum1Controls.forEach(control => {
    if (control) {
      control.disabled = drum1Empty;
      if (drum1Empty) {
        control.title = dispenserDict.drum1EmptyTooltip;
      } else {
        control.title = control.getAttribute('data-original-title') || '';
      }
    }
  });
  
  // Disable drum 2 controls if drum 2 is empty
  drum2Controls.forEach(control => {
    if (control) {
      control.disabled = drum2Empty;
      if (drum2Empty) {
        control.title = dispenserDict.drum2EmptyTooltip;
      } else {
        control.title = control.getAttribute('data-original-title') || '';
      }
    }
  });
  
  // Disable manual buttons if drums are empty
  if (manualBtn1) {
    manualBtn1.disabled = drum1Empty;
    if (drum1Empty) {
      manualBtn1.title = dispenserDict.drum1EmptyDispenseTooltip;
    } else {
      manualBtn1.title = dispenserDict.manualDispenseDrum1Tooltip;
    }
  }
  
  if (manualBtn2) {
    manualBtn2.disabled = drum2Empty;
    if (drum2Empty) {
      manualBtn2.title = dispenserDict.drum2EmptyDispenseTooltip;
    } else {
      manualBtn2.title = dispenserDict.manualDispenseDrum2Tooltip;
    }
  }
  
  // Disable save schedules button if any drum is empty
  if (saveSchedulesBtn) {
    const anyDrumEmpty = drum1Empty || drum2Empty;
    saveSchedulesBtn.disabled = anyDrumEmpty;
    if (anyDrumEmpty) {
      saveSchedulesBtn.title = dispenserDict.cannotSaveSchedulesTooltip;
    } else {
      saveSchedulesBtn.title = dispenserDict.saveSchedulesTooltip;
    }
  }
}

// Track active mode to prevent conflicts
let activeMode = null; // 'manual' or 'schedule'
let modeTimeout = null;

// Set active mode and show conflict warning if needed
function setActiveMode(mode) {
  if (activeMode && activeMode !== mode) {
    showModeConflictWarning(mode);
    return false;
  }
  
  activeMode = mode;
  
  // Clear any existing timeout
  if (modeTimeout) {
    clearTimeout(modeTimeout);
  }
  
  // Reset mode after 30 seconds of inactivity
  modeTimeout = setTimeout(() => {
    activeMode = null;
    hideModeConflictWarning();
  }, 30000);
  
  return true;
}

// Show mode conflict warning
function showModeConflictWarning(requestedMode) {
  // Get translations
  const dict = i18n[currentLang] || i18n.en;
  const modeDict = dict.modeConflict || i18n.en.modeConflict;
  
  const currentModeText = activeMode === 'manual' ? modeDict.manualDispensing : modeDict.scheduleConfiguration;
  const requestedModeText = requestedMode === 'manual' ? modeDict.manualDispensing : modeDict.scheduleConfiguration;
  
  const warningHtml = `
    <div class="mode-conflict-warning">
      <span class="warning-icon">${modeDict.warningIcon}</span>
      <strong>${modeDict.warning}</strong> ${currentModeText} ${modeDict.currentlyActive} 
      ${modeDict.pleaseWait} ${requestedModeText}.
    </div>
  `;
  
  // Show warning in both manual and schedule tabs
  const manualTab = document.getElementById('manual');
  const scheduleTab = document.getElementById('settings');
  
  // Remove existing warnings
  document.querySelectorAll('.mode-conflict-warning').forEach(el => el.remove());
  
  if (manualTab && requestedMode === 'manual') {
    manualTab.insertAdjacentHTML('afterbegin', warningHtml);
  }
  
  if (scheduleTab && requestedMode === 'schedule') {
    scheduleTab.insertAdjacentHTML('afterbegin', warningHtml);
  }
}

// Hide mode conflict warning
function hideModeConflictWarning() {
  document.querySelectorAll('.mode-conflict-warning').forEach(el => el.remove());
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
    const dict = i18n[currentLang] || i18n.en;
    const scheduleDict = dict.schedule || i18n.en.schedule;
    container.innerHTML = `<div class="empty-list">${scheduleDict.emptyList}</div>`;
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

    const ofText = (i18n[currentLang]?.medicine?.slotsAvailableOf) || "of";
    const slotsText = (i18n[currentLang]?.medicine?.slotsAvailableText) || "slots available";
    capacityEl.textContent = `(${availableSlots} ${ofText} ${MAX_SLOTS_PER_DRUM} ${slotsText})`;
    countInput.max = availableSlots;
    if (availableSlots === 0) {
        countInput.disabled = true;
        const fullText = (i18n[currentLang]?.medicine?.drumIsFull) || "Drum is full";
        countInput.placeholder = fullText;
    } else {
        countInput.disabled = false;
        const placeholderText = (i18n[currentLang]?.medicine?.addCountPlaceholder) || "Number of new medicines to add";
        countInput.placeholder = placeholderText;
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
        setInterval(refreshDispenserStatus, 15000); // Check dispenser status every 15 seconds
    }

    // Initial load
    window.addEventListener('DOMContentLoaded', () => {
      applyLanguage(localStorage.getItem(LANG_KEY) || 'en');
      initializeApp();
    });

// Minimal i18n dictionary to avoid undefined errors and support core UI strings
const i18n = {
  en: {
    app: {
      title: "💊 Medicine Dispenser"
    },
    tabs: {
      dashboard: "📊 Dashboard",
      schedule: "⏰ Schedule", 
      medicine: "💊 Medicine",
      manual: "🎮 Manual",
      settings: "⚙️ Settings"
    },
    dashboard: {
      systemStatusTitle: "System Status",
      currentTimeLabel: "Current Time",
      drum1PositionLabel: "Drum 1 Position",
      drum2PositionLabel: "Drum 2 Position", 
      wifiConnectionLabel: "WiFi Connection",
      recentActivityTitle: "Recent Activity",
      systemLogsTitle: "System Logs",
      viewFullHistory: "📋 View Full History",
      systemLogsLoading: "Loading system logs...",
      recentActivityLoading: "Loading recent activity...",
      errorText: "Error",
      offlineText: "Offline",
      dispenserStatusTitle: "Dispenser Status",
      dispenserStatusLoading: "Loading dispenser status...",
      dispenserStatusError: "Error loading dispenser status.",
      upcomingSchedulesTitle: "Upcoming Schedules",
      upcomingSchedulesEmpty: "No upcoming schedules found."
    },
    schedule: {
      addNew: "Add New Schedule",
      explain: "Schedule when medications should be dispensed automatically.",
      guardNotice: "❗ Action Required: No medicines are configured yet. Please add medicines in the Medicine tab before creating schedules.",
      datetime: "📅 Date & Time",
      medicine: "💊 Medicine",
      addButton: "Add Schedule",
      current: "📅 Current Schedules",
      emptyList: "No schedules added yet.",
      noUpcomingSchedules: "No upcoming schedules found.",
      errorLoadingSchedules: "Error loading schedules."
    },
    medicine: {
      drum1: {
        title: "Drum 1 Configuration"
      },
      drum2: {
        title: "Drum 2 Configuration"
      },
      listHeaderDrum1: "Configured Medicines in Drum 1",
      listHeaderDrum2: "Configured Medicines in Drum 2",
      addNewDrum1: "Add New Medicines to Drum 1",
      addNewDrum2: "Add New Medicines to Drum 2",
      addCountPlaceholder: "Number of new medicines to add",
      emptyDrum1: "Drum 1 is empty.",
      emptyDrum2: "Drum 2 is empty.",
      errorLoadingData: "Error loading data.",
      saveToDrum1: "💾 Save to Drum 1",
      saveToDrum2: "💾 Save to Drum 2",
      slotsAvailable: "(7 slots available)",
      slotsAvailableOf: "of",
      slotsAvailableText: "slots available",
      drumIsFull: "Drum is full"
    },
    manual: {
      title: "Manual Dispense Control",
      explain: "Manually dispense medications from either drum for testing or immediate needs.",
      dispenseDrum1: "🥁 Dispense from Drum 1",
      dispenseDrum2: "🥁 Dispense from Drum 2",
      safetyLabel: "⚠️ Safety Notice:",
      safetyText: "Manual dispensing should only be used for testing or emergency situations. Always verify the correct medication before dispensing."
    },
    settings: {
      drum1: {
        title: "Drum 1 Schedule"
      },
      drum2: {
        title: "Drum 2 Schedule"
      },
      frequency: "Schedule Frequency",
      onceOption: "Once a day",
      twiceOption: "Twice a day",
      onceExplain: "Set the time for the daily dispense.",
      twiceExplain: "Set the two times for the daily dispenses.",
      dispenseTime: "Dispense Time",
      firstDispense: "First Dispense Time",
      secondDispense: "Second Dispense Time",
      saveBtn: "💾 Save Schedules & Logically Reset Drums"
    },
    common: {
      selectMedicine: "Select a medicine"
    },
    dispenser: {
      drum: "Drum",
      isEmpty: "is empty",
      isLow: "is low",
      isGood: "is good",
      pleaseRefill: "Please refill before next scheduled dose.",
      pleaseRefillSchedule: "Please refill drums before setting schedules.",
      readyForDispensing: "Both drums are ready for dispensing",
      cannotBeScheduled: "and cannot be scheduled",
      slotsOf: "of",
      slotsFilled: "slots filled",
      fillPercentage: "Fill",
      currentSlot: "Current Slot",
      emptySlots: "Empty Slots",
      drum1EmptyTooltip: "Drum 1 is empty. Please refill before scheduling.",
      drum2EmptyTooltip: "Drum 2 is empty. Please refill before scheduling.",
      drum1EmptyDispenseTooltip: "Drum 1 is empty. Cannot dispense.",
      drum2EmptyDispenseTooltip: "Drum 2 is empty. Cannot dispense.",
      cannotSaveSchedulesTooltip: "Cannot save schedules while drums are empty. Please refill first.",
      saveSchedulesTooltip: "Save schedules and reset drums",
      manualDispenseDrum1Tooltip: "Manually dispense from Drum 1",
      manualDispenseDrum2Tooltip: "Manually dispense from Drum 2"
    },
    schedule: {
      emptyList: "No schedules added yet.",
      noUpcomingSchedules: "No upcoming schedules found.",
      errorLoadingSchedules: "Error loading schedules."
    },
    modeConflict: {
      warning: "Mode Conflict:",
      manualDispensing: "Manual Dispensing",
      scheduleConfiguration: "Schedule Configuration",
      currentlyActive: "is currently active.",
      pleaseWait: "Please wait 30 seconds or complete your current action before switching to",
      warningIcon: "⚠️"
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
    app: {
      title: "💊 موزع الأدوية"
    },
    tabs: {
      dashboard: "📊 لوحة التحكم",
      schedule: "⏰ المواعيد",
      medicine: "💊 الأدوية",
      manual: "🎮 التحكم اليدوي",
      settings: "⚙️ الإعدادات"
    },
    dashboard: {
      systemStatusTitle: "حالة النظام",
      currentTimeLabel: "الوقت الحالي",
      drum1PositionLabel: "موضع الأسطوانة 1",
      drum2PositionLabel: "موضع الأسطوانة 2",
      wifiConnectionLabel: "اتصال الواي فاي",
      recentActivityTitle: "النشاط الأخير",
      systemLogsTitle: "سجلات النظام",
      viewFullHistory: "📋 عرض السجل الكامل",
      systemLogsLoading: "جارٍ تحميل سجلات النظام...",
      recentActivityLoading: "جارٍ تحميل النشاط الأخير...",
      errorText: "خطأ",
      offlineText: "غير متصل",
      dispenserStatusTitle: "حالة الموزع",
      dispenserStatusLoading: "جارٍ تحميل حالة الموزع...",
      dispenserStatusError: "خطأ في تحميل حالة الموزع.",
      upcomingSchedulesTitle: "المواعيد القادمة",
      upcomingSchedulesEmpty: "لا توجد مواعيد قادمة."
    },
    schedule: {
      addNew: "إضافة موعد جديد",
      explain: "جدولة متى يجب صرف الأدوية تلقائياً.",
      guardNotice: "❗ إجراء مطلوب: لم يتم تكوين أي أدوية بعد. يرجى إضافة الأدوية في تبويب الأدوية قبل إنشاء المواعيد.",
      datetime: "📅 التاريخ والوقت",
      medicine: "💊 الدواء",
      addButton: "إضافة موعد",
      current: "📅 المواعيد الحالية",
      emptyList: "لم تتم إضافة مواعيد بعد.",
      noUpcomingSchedules: "لا توجد مواعيد قادمة.",
      errorLoadingSchedules: "خطأ في تحميل المواعيد."
    },
    medicine: {
      drum1: {
        title: "إعداد الأسطوانة 1"
      },
      drum2: {
        title: "إعداد الأسطوانة 2"
      },
      listHeaderDrum1: "الأدوية المكونة في الأسطوانة 1",
      listHeaderDrum2: "الأدوية المكونة في الأسطوانة 2",
      addNewDrum1: "إضافة أدوية جديدة للأسطوانة 1",
      addNewDrum2: "إضافة أدوية جديدة للأسطوانة 2",
      addCountPlaceholder: "عدد الأدوية الجديدة المراد إضافتها",
      emptyDrum1: "الأسطوانة 1 فارغة.",
      emptyDrum2: "الأسطوانة 2 فارغة.",
      errorLoadingData: "خطأ في تحميل البيانات.",
      saveToDrum1: "💾 حفظ في الأسطوانة 1",
      saveToDrum2: "💾 حفظ في الأسطوانة 2",
      slotsAvailable: "(7 فتحات متاحة)",
      slotsAvailableOf: "من",
      slotsAvailableText: "فتحات متاحة",
      drumIsFull: "الأسطوانة ممتلئة"
    },
    manual: {
      title: "التحكم في الصرف اليدوي",
      explain: "صرف الأدوية يدوياً من أي أسطوانة للاختبار أو الاحتياجات الفورية.",
      dispenseDrum1: "🥁 صرف من الأسطوانة 1",
      dispenseDrum2: "🥁 صرف من الأسطوانة 2",
      safetyLabel: "⚠️ تنبيه أمان:",
      safetyText: "يجب استخدام الصرف اليدوي فقط للاختبار أو حالات الطوارئ. تأكد دائماً من الدواء الصحيح قبل الصرف."
    },
    settings: {
      drum1: {
        title: "جدولة الأسطوانة 1"
      },
      drum2: {
        title: "جدولة الأسطوانة 2"
      },
      frequency: "تكرار الجدولة",
      onceOption: "مرة واحدة في اليوم",
      twiceOption: "مرتين في اليوم",
      onceExplain: "حدد وقت الصرف اليومي.",
      twiceExplain: "حدد الوقتين للصرف اليومي.",
      dispenseTime: "وقت الصرف",
      firstDispense: "وقت الصرف الأول",
      secondDispense: "وقت الصرف الثاني",
      saveBtn: "💾 حفظ المواعيد وإعادة تعيين الأسطوانات منطقياً"
    },
    common: {
      selectMedicine: "اختر الدواء"
    },
    dispenser: {
      drum: "الأسطوانة",
      isEmpty: "فارغة",
      isLow: "منخفضة",
      isGood: "جيدة",
      pleaseRefill: "يرجى إعادة التعبئة قبل الجرعة المجدولة التالية.",
      pleaseRefillSchedule: "يرجى إعادة تعبئة الأسطوانات قبل تحديد المواعيد.",
      readyForDispensing: "كلا الأسطوانتين جاهزتان للصرف",
      cannotBeScheduled: "ولا يمكن جدولتها",
      slotsOf: "من",
      slotsFilled: "فتحات مملوءة",
      fillPercentage: "التعبئة",
      currentSlot: "الفتحة الحالية",
      emptySlots: "الفتحات الفارغة",
      drum1EmptyTooltip: "الأسطوانة 1 فارغة. يرجى إعادة التعبئة قبل الجدولة.",
      drum2EmptyTooltip: "الأسطوانة 2 فارغة. يرجى إعادة التعبئة قبل الجدولة.",
      drum1EmptyDispenseTooltip: "الأسطوانة 1 فارغة. لا يمكن الصرف.",
      drum2EmptyDispenseTooltip: "الأسطوانة 2 فارغة. لا يمكن الصرف.",
      cannotSaveSchedulesTooltip: "لا يمكن حفظ المواعيد بينما الأسطوانات فارغة. يرجى إعادة التعبئة أولاً.",
      saveSchedulesTooltip: "حفظ المواعيد وإعادة تعيين الأسطوانات",
      manualDispenseDrum1Tooltip: "صرف يدوي من الأسطوانة 1",
      manualDispenseDrum2Tooltip: "صرف يدوي من الأسطوانة 2"
    },
    schedule: {
      emptyList: "لم تتم إضافة مواعيد بعد.",
      noUpcomingSchedules: "لا توجد مواعيد قادمة.",
      errorLoadingSchedules: "خطأ في تحميل المواعيد."
    },
    modeConflict: {
      warning: "تعارض في الوضع:",
      manualDispensing: "الصرف اليدوي",
      scheduleConfiguration: "إعداد المواعيد",
      currentlyActive: "نشط حالياً.",
      pleaseWait: "يرجى الانتظار 30 ثانية أو إكمال العملية الحالية قبل التبديل إلى",
      warningIcon: "⚠️"
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
  try { refreshDispenserStatus(); } catch (_) {}

  // Event listeners for drum 1 schedule frequency
  const scheduleFrequency1 = document.getElementById('scheduleFrequency1');
  const onceADayOptions1 = document.getElementById('onceADayOptions1');
  const twiceADayOptions1 = document.getElementById('twiceADayOptions1');
  if (scheduleFrequency1 && onceADayOptions1 && twiceADayOptions1) {
    scheduleFrequency1.addEventListener('change', function() {
      // Set schedule mode when user interacts with controls
      setActiveMode('schedule');
      
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
      // Set schedule mode when user interacts with controls
      setActiveMode('schedule');
      
      if (this.value === 'once') {
        onceADayOptions2.style.display = 'block';
        twiceADayOptions2.style.display = 'none';
      } else {
        onceADayOptions2.style.display = 'none';
        twiceADayOptions2.style.display = 'block';
      }
    });
  }
  
  // Add event listeners to all time input fields to trigger schedule mode
  const timeInputs = [
    'onceDailyTime1', 'twiceDailyTime1_1', 'twiceDailyTime1_2',
    'onceDailyTime2', 'twiceDailyTime2_1', 'twiceDailyTime2_2'
  ];
  
  timeInputs.forEach(inputId => {
    const input = document.getElementById(inputId);
    if (input) {
      input.addEventListener('focus', () => setActiveMode('schedule'));
      input.addEventListener('change', () => setActiveMode('schedule'));
    }
  });
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
      // Check for mode conflicts
      if (!setActiveMode('manual')) {
        return; // Mode conflict detected, abort
      }
      
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
        // Check for mode conflicts
        if (!setActiveMode('schedule')) {
            return; // Mode conflict detected, abort
        }
        
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