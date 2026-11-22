/**
 * ui/components/toast.js —— 轻量提示条（不阻塞操作，3 秒自动消失）。
 */

let root = null;
let seq = 0;

export function bindToastRoot(el) {
  root = el;
}

export function toast(message, kind = 'info', duration = 3200) {
  if (!root) return;
  const id = `tst_${++seq}`;
  const node = document.createElement('div');
  node.className = `toast ${kind === 'bad' ? 'bad' : kind === 'ok' ? 'ok' : ''}`;
  node.id = id;
  node.textContent = message;
  root.appendChild(node);
  const timer = setTimeout(() => {
    node.style.transition = 'opacity .3s ease, transform .3s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 320);
  }, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });
  // 最多同时显示 3 条
  while (root.children.length > 3) root.firstElementChild?.remove();
}
