// In-memory storage for medicines and schedules
let configuredMedicines = [];
let currentSchedules = [];
const MAX_SLOTS_PER_DRUM = 7;

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
      container.innerHTML = `<div class="empty-list">Drum ${drumNum} is empty.</div>`;
      continue;
    }

    container.innerHTML = '';
    drumMeds.forEach(med => {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <div class="list-item-main">
          <div class="list-item-title">Slot ${med.slot}: ${med.pillName}</div>
        </div>
        <div class="list-item-action" onclick="removeMedicine(${med.drum}, ${med.slot})" title="Remove this medicine">🗑️</div>
      `;
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
  select.innerHTML = '<option value="">Select a medicine</option>';
  
  const sortedMeds = [...configuredMedicines].sort((a,b) => {
      if (a.drum < b.drum) return -1;
      if (a.drum > b.drum) return 1;
      return a.slot - b.slot;
  });

  sortedMeds.forEach(medicine => {
    const option = document.createElement('option');
    option.value = `${medicine.drum},${medicine.slot}`;
    option.textContent = `${medicine.pillName} (Drum ${medicine.drum}, Slot ${medicine.slot})`
    select.appendChild(option);
  });
}

// Fetch medicines from the server and update the UI
async function loadAndDisplayMedicines() {
  try {
    const response = await fetch('/getSlotMap');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    configuredMedicines = await response.json();
    
    // Refresh UI components that use this data
    refreshMedicinesList();
    updateScheduleMedicineOptions();
    // Also refresh dashboard schedules as they depend on medicine names
    refreshUpcomingSchedules(); 
  } catch (error) {
    console.error('Error fetching medication status:', error);
    document.getElementById('medicinesList1').innerHTML = '<div class="empty-list" style="color: red;">Error loading data.</div>';
    document.getElementById('medicinesList2').innerHTML = '<div class="empty-list" style="color: red;">Error loading data.</div>';
  }
}

    async function manualDispense(drum) {
      let pills = prompt("How many pills to dispense?", 1);
      if (pills === null) {
        return;
      }
      let formData = new FormData();
      formData.append("drum", drum);
      formData.append("pills", pills);
      let res = await fetch('/manualDispense', { method: "POST", body: formData });
      alert(await res.text());
      refreshLogs();
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

        if (frequency1 === 'once') {
            const time1 = document.getElementById('onceDailyTime1').value;
            if (!time1) return alert('Please set a time for Drum 1.');
            scheduleData.drum1.times.push(time1);
        } else {
            const time1_1 = document.getElementById('twiceDailyTime1_1').value;
            const time1_2 = document.getElementById('twiceDailyTime1_2').value;
            if (!time1_1 || !time1_2) return alert('Please set both times for Drum 1.');
            scheduleData.drum1.times.push(time1_1, time1_2);
        }

        if (frequency2 === 'once') {
            const time2 = document.getElementById('onceDailyTime2').value;
            if (!time2) return alert('Please set a time for Drum 2.');
            scheduleData.drum2.times.push(time2);
        } else {
            const time2_1 = document.getElementById('twiceDailyTime2_1').value;
            const time2_2 = document.getElementById('twiceDailyTime2_2').value;
            if (!time2_1 || !time2_2) return alert('Please set both times for Drum 2.');
            scheduleData.drum2.times.push(time2_1, time2_2);
        }

        let formData = new FormData();
        formData.append("data", JSON.stringify(scheduleData));

        try {
            let res = await fetch('/setDailySchedules', { method: "POST", body: formData });
            alert(await res.text());
            if (res.ok) {
                await clearDrums();
            }
        } catch (err) {
            alert('Error saving schedules.');
        }
    }


    // Auto refresh functionality
    setInterval(refreshStatus, 5000);
    setInterval(refreshLogs, 10000);
    setInterval(refreshLastAction, 5000);
    setInterval(refreshUpcomingSchedules, 30000); // Refresh upcoming schedules every 30 seconds

    // Initial load
    function initializeApp() {
        refreshStatus();
        refreshLogs();
        refreshLastAction();
        loadAndDisplayMedicines(); // This will fetch data and then update the relevant UI parts
        refreshSchedulesList();
        refreshUpcomingSchedules();

        // Event listeners for drum 1 schedule frequency
        const scheduleFrequency1 = document.getElementById('scheduleFrequency1');
        const onceADayOptions1 = document.getElementById('onceADayOptions1');
        const twiceADayOptions1 = document.getElementById('twiceADayOptions1');

        scheduleFrequency1.addEventListener('change', function() {
            if (this.value === 'once') {
                onceADayOptions1.style.display = 'block';
                twiceADayOptions1.style.display = 'none';
            } else {
                onceADayOptions1.style.display = 'none';
                twiceADayOptions1.style.display = 'block';
            }
        });

        // Event listeners for drum 2 schedule frequency
        const scheduleFrequency2 = document.getElementById('scheduleFrequency2');
        const onceADayOptions2 = document.getElementById('onceADayOptions2');
        const twiceADayOptions2 = document.getElementById('twiceADayOptions2');

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

    async function clearDrums() {
        try {
            let res = await fetch('/clearDrums', { method: 'POST' });
            alert(await res.text());
            refreshStatus();
        } catch (err) {
            alert('Error clearing drums.');
        }
    }

    initializeApp();