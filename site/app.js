(() => {
  'use strict';
  const windowDemo = document.querySelector('.shelf-window');
  const tabs = [...document.querySelectorAll('[data-tab]')];
  let item = 'Field notes.txt';
  let host = 'Studio';
  let clip = 'A useful thought';
  let draggingSample = '';
  const feedback = document.querySelector('#transfer-status');
  const clipFeedback = document.querySelector('#clipboard-status');

  function selectTab(name, focus) {
    tabs.forEach(button => {
      const active = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      document.querySelector('#panel-' + button.dataset.tab).hidden = !active;
      if (active && focus) button.focus();
    });
  }
  tabs.forEach(button => {
    button.addEventListener('click', () => selectTab(button.dataset.tab, false));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.tab, true);
    });
  });
  document.querySelector('#density').addEventListener('change', event => { windowDemo.dataset.density = event.target.value; });
  function updateSelection() { document.querySelector('#selection-description').textContent = item + ' → ' + host; }
  function selectItem(name) {
    item = name;
    document.querySelectorAll('[data-item]').forEach(button => { const active = button.dataset.item === item; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
    updateSelection();
  }
  function selectHost(name) {
    host = name;
    document.querySelectorAll('[data-host]').forEach(button => { const active = button.dataset.host === host; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
    updateSelection();
  }
  function sendSample() { feedback.textContent = 'Sample sent: ' + item + ' to ' + host + '. In the app, a receipt confirms the transfer.'; feedback.classList.add('success'); }
  document.querySelectorAll('[data-item]').forEach(button => {
    button.addEventListener('click', () => selectItem(button.dataset.item));
    button.addEventListener('dragstart', event => { draggingSample = button.dataset.item; selectItem(draggingSample); event.dataTransfer.setData('text/plain', draggingSample); event.dataTransfer.effectAllowed = 'copy'; });
    button.addEventListener('dragend', () => { draggingSample = ''; document.querySelectorAll('.drop-ready').forEach(el => el.classList.remove('drop-ready')); });
  });
  document.querySelectorAll('[data-host]').forEach(button => {
    button.addEventListener('click', () => selectHost(button.dataset.host));
    button.addEventListener('dragover', event => { event.preventDefault(); if (draggingSample) { event.dataTransfer.dropEffect = 'copy'; button.classList.add('drop-ready'); } else event.dataTransfer.dropEffect = 'none'; });
    button.addEventListener('dragleave', event => { if (!button.contains(event.relatedTarget)) button.classList.remove('drop-ready'); });
    button.addEventListener('drop', event => { event.preventDefault(); button.classList.remove('drop-ready'); if (!draggingSample) { feedback.textContent = 'This sample does not accept real files. Try dragging one of the two sample items.'; return; } selectItem(draggingSample); selectHost(button.dataset.host); draggingSample = ''; sendSample(); });
  });
  // External drops never navigate the page or upload content.
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());
  document.querySelector('#send-sample').addEventListener('click', sendSample);
  document.querySelector('#enable-demo-clipboard').addEventListener('click', () => {
    document.querySelector('#clipboard-off').hidden = true;
    document.querySelector('#clipboard-on').hidden = false;
    document.querySelector('#clipboard-state').textContent = 'Sample preview';
    document.querySelector('#clip-search').focus();
  });
  document.querySelectorAll('[data-clip]').forEach(button => button.addEventListener('click', () => {
    clip = button.dataset.clip;
    document.querySelectorAll('[data-clip]').forEach(row => row.setAttribute('aria-pressed', String(row === button)));
  }));
  document.querySelector('#clip-search').addEventListener('input', event => {
    const query = event.target.value.toLocaleLowerCase().trim();
    const rows = [...document.querySelectorAll('[data-clip]')];
    rows.forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase().includes(query); });
    const visible = rows.filter(row => !row.hidden);
    if (!visible.some(row => row.dataset.clip === clip) && visible.length) clip = visible[0].dataset.clip;
    rows.forEach(row => row.setAttribute('aria-pressed', String(!row.hidden && row.dataset.clip === clip)));
    document.querySelector('#clip-empty').hidden = visible.length !== 0;
    document.querySelectorAll('.clip-actions button').forEach(button => { button.disabled = !visible.length; });
  });
  document.querySelector('#sample-copy').addEventListener('click', () => { clipFeedback.textContent = 'Copy preview: “' + clip + '”. Your system clipboard was not changed.'; });
  document.querySelector('#sample-plain').addEventListener('click', () => { clipFeedback.textContent = 'Plain-text preview: “' + clip + '”. No formatting, and no change to your system clipboard.'; });
  document.querySelector('#sample-add').addEventListener('click', () => { clipFeedback.textContent = 'In ShelfDock, “' + clip + '” is added to Transfers first. Nothing is sent until you choose a destination.'; });
})();
