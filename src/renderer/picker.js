// 턴 숫자 영역 고르기 — 드래그한 사각형을 화면 대비 비율(0~1)로 넘긴다.
//
// 비율로 넘기는 이유: 나중에 해상도나 배율이 바뀌어도 같은 자리를 가리킨다.
'use strict';

/** 이보다 작게 잡으면 숫자가 몇 픽셀 안 돼 인식이 흔들린다 */
const MIN_SIDE = 12;

let displayId = null;
let dragging = false;
let sx = 0;
let sy = 0;

const rect = document.getElementById('rect');
const size = document.getElementById('size');

window.picker.onInit((data) => {
  displayId = data.displayId;
});

function update(e) {
  const x = Math.min(sx, e.clientX);
  const y = Math.min(sy, e.clientY);
  const w = Math.abs(e.clientX - sx);
  const h = Math.abs(e.clientY - sy);
  rect.style.left = `${x}px`;
  rect.style.top = `${y}px`;
  rect.style.width = `${w}px`;
  rect.style.height = `${h}px`;
  size.textContent = `${w} × ${h}`;
  size.className = h < MIN_SIDE || w < MIN_SIDE ? 'small' : '';
  return { x, y, w, h };
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  sx = e.clientX;
  sy = e.clientY;
  rect.style.display = 'block';
  update(e);
});

document.addEventListener('mousemove', (e) => {
  if (dragging) update(e);
});

document.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const { x, y, w, h } = update(e);
  if (w < MIN_SIDE || h < MIN_SIDE) {
    rect.style.display = 'none';
    return; // 잘못 클릭했거나 너무 작다 — 다시 드래그
  }
  window.picker.done({
    displayId,
    fx: x / window.innerWidth,
    fy: y / window.innerHeight,
    fw: w / window.innerWidth,
    fh: h / window.innerHeight,
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.picker.cancel();
});

// 게임에 포커스가 남아 있으면 키가 안 들어온다 — 손이 이미 마우스에 있으니 우클릭으로도 나가게
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.picker.cancel();
});
