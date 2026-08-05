(function () {
  "use strict";

  var copy = {
    Science: "SCIENCE — methods, peer review, field notes. No party line.",
    Technology: "TECHNOLOGY — systems, safety, infrastructure. Utility over cult.",
    Culture: "CULTURE — music, craft, community. Human signal worldwide.",
    Climate: "CLIMATE — heat, water, land. Data first, ideology last.",
    Health: "HEALTH — care systems and public facts. No wellness grift.",
    World: "WORLD — cross-border human stories. Not geopolitical scorekeeping.",
    "Civic records": "CIVIC RECORDS — budgets, outages, documents. Process over personality.",
    "Media literacy": "MEDIA LITERACY — verify before you share. Scams lose to receipts.",
  };

  var board = document.getElementById("desk-board");
  var readout = document.getElementById("desk-readout");
  if (!board || !readout) return;

  board.addEventListener("click", function (e) {
    var btn = e.target.closest(".desk-node");
    if (!btn) return;
    var desk = btn.getAttribute("data-desk");
    board.querySelectorAll(".desk-node").forEach(function (n) {
      n.classList.toggle("active", n === btn);
    });
    readout.textContent = copy[desk] || desk;
  });
})();
