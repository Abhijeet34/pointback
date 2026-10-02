// The one behaviour the component layer needs a script for: a segmented control is a radio
// group, so it is one Tab stop and the arrow keys move the choice (WAI-ARIA APG radio group).
// Home and End jump to the ends; a disabled segment is skipped. Load once, deferred.
addEventListener("DOMContentLoaded", () => {
  for (const group of document.querySelectorAll(".hw-segmented[role=radiogroup]")) {
    const radios = () => [...group.querySelectorAll("[role=radio]:not(:disabled)")];
    const pick = (radio, focus) => {
      for (const r of group.querySelectorAll("[role=radio]")) {
        r.setAttribute("aria-checked", String(r === radio));
        r.tabIndex = r === radio ? 0 : -1;
      }
      if (focus) radio.focus();
      group.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const all = radios();
    if (!all.length) continue;
    pick(all.find(r => r.getAttribute("aria-checked") === "true") || all[0], false);
    group.addEventListener("click", e => {
      const r = e.target.closest("[role=radio]");
      if (r && !r.disabled) pick(r, true);
    });
    group.addEventListener("keydown", e => {
      const rs = radios(), i = rs.indexOf(document.activeElement);
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: rs.length - 1 }[e.key];
      if (to === undefined || i < 0) return;
      e.preventDefault();
      pick(rs[(to + rs.length) % rs.length], true);
    });
  }
});
