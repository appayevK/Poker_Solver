// Entry point: sets up tab navigation and mounts the active tab.
import { renderReviewTab } from './ui/tabs/review-tab.js';
import { renderRangesTab } from './ui/tabs/ranges-tab.js';
import { renderEquityTab } from './ui/tabs/equity-tab.js';
import { renderIcmTab } from './ui/tabs/icm-tab.js';
import { renderNashTab } from './ui/tabs/nash-tab.js';

const tabs = {
  review: renderReviewTab,
  ranges: renderRangesTab,
  equity: renderEquityTab,
  icm: renderIcmTab,
  nash: renderNashTab,
};

function show(name) {
  const root = document.getElementById('app');
  root.replaceChildren();
  tabs[name](root);
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name),
  );
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const name = e.target.dataset?.tab;
  if (name) show(name);
});

show('equity');
