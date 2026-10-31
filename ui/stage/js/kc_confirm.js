// Stira-KIRO: the confirmation dialog the Stage asks for (window.StiraConfirm in StiraCore's shell).
// open({ title, intro, items, confirmLabel, cancelLabel }) -> Promise<boolean>.
// Cancel is the default and has the first focus; Esc and a click outside cancel. Text only
// (textContent), built inside the Stage root so its styles stay scoped.

export function makeConfirm(root) {
  let busy = null;
  return {
    open({ title = '', intro = '', items = [], confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
      if (busy) return busy;
      busy = new Promise((resolve) => {
        const veil = document.createElement('div');
        veil.className = 'kc-confirm-veil';
        const box = document.createElement('div');
        box.className = 'kc-confirm';
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-modal', 'true');
        const h = document.createElement('h2');
        h.textContent = title;
        box.append(h);
        if (intro) {
          const p = document.createElement('p');
          p.textContent = intro;
          box.append(p);
        }
        if (items.length) {
          const ul = document.createElement('ul');
          for (const it of items) {
            const li = document.createElement('li');
            li.textContent = String(it);
            ul.append(li);
          }
          box.append(ul);
        }
        const row = document.createElement('div');
        row.className = 'kc-confirm-buttons';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'mini';
        cancel.textContent = cancelLabel;
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'mini kc-confirm-ok';
        ok.textContent = confirmLabel;
        row.append(cancel, ok);
        box.append(row);
        veil.append(box);
        const done = (v) => {
          veil.remove();
          document.removeEventListener('keydown', onKey, true);
          busy = null;
          resolve(v);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            done(false);
          }
        };
        cancel.addEventListener('click', () => done(false));
        ok.addEventListener('click', (e) => {
          if (e.detail === 0 && e.repeat) return;
          done(true);
        });
        veil.addEventListener('click', (e) => {
          if (e.target === veil) done(false);
        });
        document.addEventListener('keydown', onKey, true);
        root.append(veil);
        cancel.focus();
      });
      return busy;
    },
  };
}
