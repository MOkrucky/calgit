const vscode = acquireVsCodeApi();
let commitsByDate = {};
let displayYear = null;
let displayMonth = null;
let currentFileUri = null;
let activeCommit = null;
let compareBaseCommit = null;
let selectedDayKey = null;
let selectedDayCommits = [];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function setStatus(text, level = 'info') {
   const status = document.getElementById('status');
   status.textContent = text;
   status.className = level === 'error' ? 'error' : '';
}

function shortHash(hash) {
   return String(hash || '').slice(0, 7);
}

function sortCommitsNewestFirst(commits) {
   return (commits || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function pad2(value) {
   return String(value).padStart(2, '0');
}

function toDateKey(dateObj) {
   return dateObj.getFullYear() + '-' + pad2(dateObj.getMonth() + 1) + '-' + pad2(dateObj.getDate());
}

function parseDateKey(key) {
   const parts = String(key).split('-').map(Number);
   if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) {
      return null;
   }
   return new Date(parts[0], parts[1] - 1, parts[2]);
}

function resetDisplayMonthToLatestCommit() {
   const keys = Object.keys(commitsByDate).sort();
   const ref = (keys.length > 0 && parseDateKey(keys[keys.length - 1])) || new Date();
   displayYear = ref.getFullYear();
   displayMonth = ref.getMonth();
}

function indexCommits(commits) {
   commitsByDate = {};
   if (!Array.isArray(commits)) return;
   commits.forEach(c => {
      if (!c || typeof c.date !== 'string') return;
      const key = c.date.slice(0, 10);
      (commitsByDate[key] ||= []).push(c);
   });
}

function parseBranchFromRefs(refs) {
   if (!refs) return '';
   const headMatch = refs.match(/HEAD -> ([^,]+)/);
   if (headMatch) return headMatch[1].trim();
   const parts = refs.split(',').map(s => s.trim()).filter(Boolean);
   const local = parts.find(p => !p.startsWith('origin/') && !p.startsWith('tag:') && p !== 'HEAD');
   return local || '';
}

function renderWeekdays() {
   const row = document.getElementById('weekdayRow');
   row.innerHTML = '';
   weekdayNames.forEach(name => {
      const cell = document.createElement('div');
      cell.className = 'weekdayCell';
      cell.textContent = name;
      row.appendChild(cell);
   });
}

function renderCalendar() {
   if (displayYear === null || displayMonth === null) {
      resetDisplayMonthToLatestCommit();
   }

   document.getElementById('monthLabel').textContent = monthNames[displayMonth] + ' ' + displayYear;
   const grid = document.getElementById('calendarGrid');
   grid.innerHTML = '';

   const todayKey = toDateKey(new Date());
   const firstWeekday = new Date(displayYear, displayMonth, 1).getDay();
   const daysInMonth = new Date(displayYear, displayMonth + 1, 0).getDate();
   const prevMonthDays = new Date(displayYear, displayMonth, 0).getDate();

   for (let i = 0; i < 42; i++) {
      let dayNumber = 0;
      let monthOffset = 0;
      if (i < firstWeekday) {
         dayNumber = prevMonthDays - firstWeekday + i + 1;
         monthOffset = -1;
      } else if (i >= firstWeekday + daysInMonth) {
         dayNumber = i - (firstWeekday + daysInMonth) + 1;
         monthOffset = 1;
      } else {
         dayNumber = i - firstWeekday + 1;
      }

      const dayDate = new Date(displayYear, displayMonth + monthOffset, dayNumber);
      const dateKey = toDateKey(dayDate);
      const dayCommits = sortCommitsNewestFirst(commitsByDate[dateKey] || []);

      const button = document.createElement('button');
      button.className = 'dayCell';
      button.dataset.date = dateKey;
      if (monthOffset !== 0) {
         button.classList.add('outsideMonth');
      }
      if (dateKey === todayKey) {
         button.classList.add('today');
      }
      if (dayCommits.length > 0) {
         button.classList.add('hasCommits');
      } else {
         button.disabled = true;
      }

      const dayHeader = document.createElement('div');
      dayHeader.className = 'dayHeader';

      const dayText = document.createElement('div');
      dayText.className = 'dayNumber';
      dayText.textContent = String(dayNumber);
      dayHeader.appendChild(dayText);

      button.appendChild(dayHeader);

      if (dayCommits.length > 0) {
         const badge = document.createElement('div');
         badge.className = 'commitCount';
         badge.textContent = String(dayCommits.length);
         dayHeader.appendChild(badge);

         const branchText = parseBranchFromRefs(dayCommits[0].refs || '');
         if (branchText) {
            const branchDiv = document.createElement('div');
            branchDiv.className = 'dayBranch';
            branchDiv.textContent = branchText;
            button.appendChild(branchDiv);
         }

         button.title = dayCommits.slice(0, 5).map(c => c.message).join('\n');
         button.onclick = () => onDateClick(dateKey);
         button.oncontextmenu = event => {
            event.preventDefault();
            showCommitContextMenu(event, dayCommits[0], dayCommits.length);
         };
      }

      grid.appendChild(button);
   }
}

function shiftMonth(delta) {
   const shifted = new Date(displayYear, displayMonth + delta, 1);
   displayYear = shifted.getFullYear();
   displayMonth = shifted.getMonth();
   renderCalendar();
}

function clearCommitInfo(text = 'Select a highlighted day to view commit details.') {
   activeCommit = null;
   const panel = document.getElementById('commitInfo');
   panel.className = 'empty';
   panel.textContent = text;
}

function createInfoRow(label, value) {
   const row = document.createElement('div');
   row.className = 'infoRow';
   const labelSpan = document.createElement('span');
   labelSpan.className = 'infoLabel';
   labelSpan.textContent = label + ':';
   const valueSpan = document.createElement('span');
   valueSpan.textContent = value;
   row.appendChild(labelSpan);
   row.appendChild(valueSpan);
   return row;
}

function parseDate(isoDate) {
   const d = new Date(isoDate);
   return Number.isNaN(d.getTime()) ? null : d;
}

function formatCommitDate(isoDate) {
   const d = parseDate(isoDate);
   return d ? d.toLocaleString() : isoDate;
}

function formatCommitTime(isoDate) {
   const d = parseDate(isoDate);
   return d ? d.toLocaleTimeString() : isoDate;
}

function createCommitActions(commit, onSelect) {
   const specs = [
      { text: 'Open Snapshot', title: '',                    note: 'Opening snapshot',              cmd: 'openCommit' },
      { text: '↔ Current',     title: 'Diff vs working tree',  note: 'Opening diff vs working tree',  cmd: 'openDiffWithCurrent' },
      { text: '↔ Prev',        title: 'Diff vs previous commit', note: 'Opening diff vs previous commit', cmd: 'openDiffWithPrevious' },
   ];
   const actions = document.createElement('div');
   actions.className = 'commitActions';
   specs.forEach(({ text, title, note, cmd }) => {
      const btn = document.createElement('button');
      btn.className = 'commitActionBtn';
      btn.textContent = text;
      if (title) btn.title = title;
      btn.onclick = () => {
         if (onSelect) onSelect();
         showCommitInfo(commit, note);
         vscode.postMessage({ command: cmd, hash: commit.hash, fileUri: commit.fileUri });
      };
      actions.appendChild(btn);
   });
   return actions;
}

function showCommitInfo(commit, note = '') {
   activeCommit = commit || null;
   const panel = document.getElementById('commitInfo');
   panel.className = '';
   panel.innerHTML = '';

   const title = document.createElement('div');
   title.className = 'infoTitle';
   title.textContent = 'Commit Details';
   panel.appendChild(title);

   panel.appendChild(createInfoRow('Message', commit.message || ''));
   panel.appendChild(createInfoRow('Author', commit.author || 'unknown'));
   panel.appendChild(createInfoRow('When', formatCommitDate(commit.date || 'unknown')));
   panel.appendChild(createInfoRow('Hash', commit.hash || 'unknown'));
   const branchText = parseBranchFromRefs(commit.refs || '');
   if (branchText) {
      panel.appendChild(createInfoRow('Branch', branchText));
   }
   if (compareBaseCommit) {
      panel.appendChild(createInfoRow('Compare Base', shortHash(compareBaseCommit.hash)));
   }
   if (note) {
      panel.appendChild(createInfoRow('Action', note));
   }

   panel.appendChild(createCommitActions(commit));
}

function clearDayCommitList(text = 'Select a day with multiple commits to see all options.') {
   selectedDayKey = null;
   selectedDayCommits = [];
   const panel = document.getElementById('dayCommitList');
   panel.className = 'empty';
   panel.textContent = text;
}

function renderDayCommitList(date, options, selectedHash = '') {
   selectedDayKey = date;
   selectedDayCommits = (options || []).slice();

   const panel = document.getElementById('dayCommitList');
   panel.className = '';
   panel.innerHTML = '';

   const title = document.createElement('div');
   title.className = 'dayCommitTitle';
   title.textContent = 'Commits on ' + date + ' (' + String(selectedDayCommits.length) + ')';
   panel.appendChild(title);

   selectedDayCommits.forEach(commit => {
      const item = document.createElement('div');
      item.className = 'dayCommitItem';
      if (selectedHash && commit.hash === selectedHash) {
         item.classList.add('active');
      }

      const body = document.createElement('div');
      body.className = 'commitItemBody';

      const meta = document.createElement('div');
      meta.className = 'dayCommitMeta';
      meta.textContent = shortHash(commit.hash) + '  ' + formatCommitTime(commit.date) + '  ' + (commit.author || 'unknown');
      body.appendChild(meta);

      const message = document.createElement('div');
      message.className = 'dayCommitMessage';
      message.textContent = commit.message || '';
      body.appendChild(message);

      body.onclick = () => {
         showCommitInfo(commit);
         renderDayCommitList(date, selectedDayCommits, commit.hash);
      };
      item.appendChild(body);

      item.appendChild(createCommitActions(commit, () => renderDayCommitList(date, selectedDayCommits, commit.hash)));
      item.oncontextmenu = event => {
         event.preventDefault();
         showCommitContextMenu(event, commit, selectedDayCommits.length);
      };
      panel.appendChild(item);
   });
}

function hideContextMenu() {
   const menu = document.getElementById('contextMenu');
   menu.classList.add('hidden');
   menu.innerHTML = '';
}

function appendContextMenuButton(menu, label, onClick, disabled = false) {
   const button = document.createElement('button');
   button.className = 'contextMenuItem';
   button.textContent = label;
   button.disabled = disabled;
   button.onclick = () => {
      hideContextMenu();
      if (!disabled) {
         onClick();
      }
   };
   menu.appendChild(button);
}

function appendContextMenuHint(menu, text) {
   const hint = document.createElement('div');
   hint.className = 'contextMenuHint';
   hint.textContent = text;
   menu.appendChild(hint);
}

function showCommitContextMenu(event, commit, commitCountForDay = 1) {
   if (!commit) {
      return;
   }
   activeCommit = commit;
   const menu = document.getElementById('contextMenu');
   menu.innerHTML = '';

   appendContextMenuHint(menu, 'Commit ' + shortHash(commit.hash));
   if (commitCountForDay > 1) {
      appendContextMenuHint(menu, 'Using latest of ' + String(commitCountForDay) + ' commits on this day');
   }

   appendContextMenuButton(menu, 'Open Snapshot', () => {
      showCommitInfo(commit, 'Opening snapshot');
      vscode.postMessage({ command: 'openCommit', hash: commit.hash, fileUri: commit.fileUri });
   });
   appendContextMenuButton(menu, 'Diff vs Current File', () => {
      showCommitInfo(commit, 'Opening diff vs working tree');
      vscode.postMessage({ command: 'openDiffWithCurrent', hash: commit.hash, fileUri: commit.fileUri });
   });
   appendContextMenuButton(menu, 'Diff vs Previous Version', () => {
      showCommitInfo(commit, 'Opening diff vs previous commit');
      vscode.postMessage({ command: 'openDiffWithPrevious', hash: commit.hash, fileUri: commit.fileUri });
   });
   appendContextMenuButton(menu, 'Set ' + shortHash(commit.hash) + ' as Compare Base', () => {
      compareBaseCommit = commit;
      showCommitInfo(commit, 'Compare base updated');
      setStatus('Compare base set to ' + shortHash(commit.hash) + '.');
   });

   const canCompareWithBase = !!compareBaseCommit && compareBaseCommit.fileUri === commit.fileUri && compareBaseCommit.hash !== commit.hash;
   const compareLabel = compareBaseCommit
      ? 'Diff ' + shortHash(compareBaseCommit.hash) + ' <-> ' + shortHash(commit.hash)
      : 'Diff with Compare Base';
   appendContextMenuButton(menu, compareLabel, () => {
      showCommitInfo(commit, 'Opening diff vs ' + shortHash(compareBaseCommit.hash));
      vscode.postMessage({
         command: 'openDiffBetweenCommits',
         leftHash: compareBaseCommit.hash,
         rightHash: commit.hash,
         fileUri: commit.fileUri
      });
   }, !canCompareWithBase);

   appendContextMenuButton(menu, 'Clear Compare Base', () => {
      compareBaseCommit = null;
      if (activeCommit) {
         showCommitInfo(activeCommit, 'Compare base cleared');
      } else {
         clearCommitInfo();
      }
      setStatus('Compare base cleared.');
   }, !compareBaseCommit);

   menu.classList.remove('hidden');
   const maxLeft = window.innerWidth - 240;
   const maxTop = window.innerHeight - 220;
   menu.style.left = Math.max(8, Math.min(event.clientX, maxLeft)) + 'px';
   menu.style.top = Math.max(8, Math.min(event.clientY, maxTop)) + 'px';
}

function requestCurrentFileCommits() {
   hideContextMenu();
   clearDayCommitList('Loading day commits...');
   if (!currentFileUri) {
      setStatus('Resolving active file...');
      clearCommitInfo('Trying to detect active file...');
      vscode.postMessage({command:'requestActiveFile'});
      return;
   }
   setStatus('Loading commits...');
   clearCommitInfo('Loading commit details...');
   vscode.postMessage({command:'requestCommits', fileUri: currentFileUri});
}

window.addEventListener('message', event => {
   const msg = event.data;
   if (msg.command === 'setFile') {
      currentFileUri = msg.fileUri || null;
      compareBaseCommit = null;
      activeCommit = null;
      requestCurrentFileCommits();
   } else if (msg.command === 'commits') {
      indexCommits(msg.commits);
      resetDisplayMonthToLatestCommit();
      renderCalendar();
      const count = Array.isArray(msg.commits) ? msg.commits.length : 0;
      setStatus(count > 0 ? 'Loaded ' + count + ' commit(s).' : 'No commits found for this file in the current branch.');
      clearCommitInfo(count > 0 ? 'Select a highlighted day to view commit details.' : 'No commit details available for this file.');
      clearDayCommitList(count > 0 ? 'Select a day to list all commits for that day.' : 'No day options available for this file.');
   } else if (msg.command === 'status') {
      setStatus(msg.message, msg.level);
   }
});
function onDateClick(date) {
   hideContextMenu();
   const options = sortCommitsNewestFirst(commitsByDate[date] || []);
   if (options.length === 0) {
      return;
   }
   document.querySelectorAll('.dayCell.selected').forEach(el => el.classList.remove('selected'));
   const dayBtn = document.querySelector('.dayCell[data-date="' + date + '"]');
   if (dayBtn) dayBtn.classList.add('selected');
   renderDayCommitList(date, options, options[0].hash);
   showCommitInfo(options[0]);
}
document.getElementById('prevMonth').addEventListener('click', () => shiftMonth(-1));
document.getElementById('nextMonth').addEventListener('click', () => shiftMonth(1));
document.getElementById('reloadHistoryButton').addEventListener('click', () => requestCurrentFileCommits());
document.getElementById('commitInfo').addEventListener('contextmenu', event => {
   if (!activeCommit) {
      return;
   }
   event.preventDefault();
   showCommitContextMenu(event, activeCommit, 1);
});
window.addEventListener('click', () => hideContextMenu());
window.addEventListener('blur', () => hideContextMenu());
window.addEventListener('scroll', () => hideContextMenu(), true);
window.addEventListener('keydown', event => {
   if (event.key === 'Escape') {
      hideContextMenu();
   }
});
renderWeekdays();
resetDisplayMonthToLatestCommit();
renderCalendar();
