async function loadArchive() {
  const res = await fetch('data.json');
  const data = await res.json();

  document.getElementById('site-title').textContent = data.siteTitle;
  document.getElementById('site-subtitle').textContent = data.siteSubtitle;
  document.getElementById('last-updated').textContent = data.lastUpdated || '미기재';

  const rangeBar = document.getElementById('range-bar');
  rangeBar.innerHTML = (data.rangeLabels || [])
    .map(label => `<span>${escapeHtml(label)}</span>`)
    .join('');

  const container = document.getElementById('entries');
  container.innerHTML = data.entries.map(renderEntry).join('');
}

function renderEntry(entry) {
  const claimLabel = entry.claimLabel || '제기된 주장';
  const responseLabel = entry.responseLabel || '공식 답변 / 조사 결과';
  return `
    <div class="entry">
      <div class="stamp ${escapeAttr(entry.status)}">${escapeHtml(entry.statusLabel)}</div>
      <div class="entry-meta">
        <span>${escapeHtml(entry.tag)}</span>
        <span>${escapeHtml(entry.date)}</span>
      </div>
      <h2>${escapeHtml(entry.title)}</h2>
      <div class="cols">
        <div class="col claim">
          <h3>${escapeHtml(claimLabel)}</h3>
          <p>${escapeHtml(entry.claim)}</p>
        </div>
        <div class="col">
          <h3>${escapeHtml(responseLabel)}</h3>
          <p>${escapeHtml(entry.response)}</p>
        </div>
      </div>
      <div class="source-line">${escapeHtml(entry.sources)}</div>
    </div>
  `;
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/[^a-zA-Z0-9\-_]/g, '');
}

loadArchive().catch(err => {
  document.getElementById('entries').innerHTML =
    '<p style="font-family:sans-serif;color:#8C2F2F;">데이터를 불러오지 못했습니다. data.json 파일을 확인해주세요.</p>';
  console.error(err);
});
