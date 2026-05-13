const fs = require('fs');
const file = 'src/styles/global.css';
const content = fs.readFileSync(file, 'utf8');
const goodLines = content.split('\n').slice(0, 17440);
const newCSS = `
/* ── Skeletons ───────────────────────────────────────────────────────── */
.ugd-ext-section--loading {
  opacity: 0.6;
  pointer-events: none;
}

.ugd-about-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ugd-media-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ugd-media-skeleton__main {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-md);
  margin: 0;
}

.ugd-media-skeleton__thumbs {
  display: flex;
  gap: 12px;
  overflow: hidden;
}

.ugd-media-skeleton__thumb {
  flex: 0 0 calc(25% - 9px);
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  margin: 0;
}
`;
fs.writeFileSync(file, goodLines.join('\n') + newCSS);
console.log('Fixed CSS');
