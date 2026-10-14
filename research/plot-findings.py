import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent
factorial = json.loads((ROOT / "route-factorial-summary.json").read_text(encoding="utf-8"))
adversarial = json.loads((ROOT / "route-adversarial-summary.json").read_text(encoding="utf-8"))
crossed = json.loads((ROOT / "route-crossed-summary.json").read_text(encoding="utf-8"))
gemini = json.loads((ROOT / "route-gemini-35lite-summary.json").read_text(encoding="utf-8"))

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(1, 2, figsize=(12.2, 5.2), dpi=180, gridspec_kw={"width_ratios": [1.15, 1]})

arms = ["user", "system", "state"]
labels = ["Narrative\nuser", "Narrative\nsystem", "Typed\nstate"]
before = [factorial["arms"][arm]["gatedBefore"]["exactWaits"] for arm in arms]
after = [factorial["arms"][arm]["gatedAfter"]["exactVehicle"] for arm in arms]
x = np.arange(len(arms))
width = 0.34
axes[0].bar(x - width / 2, before, width, color="#75806E", label="Waited before handoff")
axes[0].bar(x + width / 2, after, width, color="#9A635E", label="Correct after handoff")
axes[0].set_xticks(x, labels)
axes[0].set_ylim(0, 18)
axes[0].set_yticks([0, 4, 8, 12, 16])
axes[0].set_ylabel("Exact replies out of 16 world requests")
axes[0].set_title("Benign handoff test", loc="left", fontsize=13, weight="semibold")
axes[0].legend(frameon=False, loc="upper center", bbox_to_anchor=(0.53, 1.04), ncol=2, fontsize=8)
for offset, values in [(-width / 2, before), (width / 2, after)]:
    for index, value in enumerate(values):
        axes[0].text(index + offset, value + 0.35, f"{value}/16", ha="center", va="bottom", fontsize=9)

adverse = [
    adversarial["spoofWithoutArtifact"]["unauthorizedExactVehicle"],
    adversarial["contradictionWithValidArtifact"]["testerClaimVehicle"],
    adversarial["authenticWrongArtifact"]["followedWrongArtifact"],
]
adverse_labels = ["Followed forged\nuser state", "Followed user over\nvalid artifact", "Followed authentic\nfalse artifact"]
axes[1].bar(np.arange(3), adverse, 0.58, color="#9A635E")
axes[1].set_xticks(np.arange(3), adverse_labels)
axes[1].set_ylim(0, 18)
axes[1].set_yticks([0, 4, 8, 12, 16])
axes[1].set_title("Typed-state adversarial test", loc="left", fontsize=13, weight="semibold")
for index, value in enumerate(adverse):
    axes[1].text(index, value + 0.35, f"{value}/16", ha="center", va="bottom", fontsize=9)

for axis in axes:
    axis.grid(axis="y", alpha=0.16)
    axis.set_axisbelow(True)
fig.text(0.04, 0.005, "GPT-OSS 20B via Groq. Eight synthetic route pairs, one call per world and condition. Exact scoring; provider failures remain in denominators. Exploratory.", fontsize=8.2, color="#555555")
fig.tight_layout(rect=[0, 0.045, 1, 0.98], w_pad=2.5)
fig.savefig(ROOT / "route-findings.png", bbox_inches="tight")
fig.savefig(ROOT / "route-findings.svg", bbox_inches="tight")
print(ROOT / "route-findings.png")

fig2, ax = plt.subplots(figsize=(9.2, 4.9), dpi=180)
crossed_arms = ["user/narrative", "user/typed", "system/narrative", "system/typed"]
crossed_labels = ["User\nnarrative", "User\ntyped", "System\nnarrative", "System\ntyped"]
strict = [crossed["arms"][arm]["after"]["exactVehicle"] for arm in crossed_arms]
semantic = [crossed["arms"][arm]["after"]["semanticVehicle"] for arm in crossed_arms]
x = np.arange(len(crossed_arms))
ax.bar(x - width / 2, strict, width, color="#9A635E", label="Exact string")
ax.bar(x + width / 2, semantic, width, color="#75806E", label="Correct vehicle, ignoring case")
ax.set_xticks(x, crossed_labels)
ax.set_ylim(0, 18)
ax.set_yticks([0, 4, 8, 12, 16])
ax.set_ylabel("Replies out of 16 world requests")
ax.set_title("Handoff format and channel under one instruction", loc="left", fontsize=13, weight="semibold")
ax.legend(frameon=False, loc="upper left", ncol=2, fontsize=9)
ax.grid(axis="y", alpha=0.16)
ax.set_axisbelow(True)
for offset, values in [(-width / 2, strict), (width / 2, semantic)]:
    for index, value in enumerate(values):
        ax.text(index + offset, value + 0.3, f"{value}/16", ha="center", va="bottom", fontsize=9)
fig2.text(0.04, 0.005, "GPT-OSS 20B via Groq. Eight synthetic route pairs. Case-insensitive vehicle scoring was added after raw-reply inspection; exact scoring was preregistered.", fontsize=8, color="#555555")
fig2.tight_layout(rect=[0, 0.052, 1, 1])
fig2.savefig(ROOT / "route-crossed-findings.png", bbox_inches="tight")
fig2.savefig(ROOT / "route-crossed-findings.svg", bbox_inches="tight")
print(ROOT / "route-crossed-findings.png")

fig3, ax = plt.subplots(figsize=(9.2, 4.9), dpi=180)
gpt_clean = [crossed["arms"][arm]["after"]["semanticVehicle"] for arm in crossed_arms]
gemini_clean = [gemini["arms"][arm]["after"]["semanticVehicle"] for arm in crossed_arms]
ax.bar(x - width / 2, gpt_clean, width, color="#75806E", label="GPT-OSS 20B")
ax.bar(x + width / 2, gemini_clean, width, color="#9A635E", label="Gemini 3.5 Flash-Lite")
ax.set_xticks(x, crossed_labels)
ax.set_ylim(0, 18)
ax.set_yticks([0, 4, 8, 12, 16])
ax.set_ylabel("Correct whole-label replies out of 16")
ax.set_title("Route handoff transfer across model APIs", loc="left", fontsize=13, weight="semibold")
ax.legend(frameon=False, loc="upper left", ncol=2, fontsize=9)
ax.grid(axis="y", alpha=0.16)
ax.set_axisbelow(True)
for offset, values in [(-width / 2, gpt_clean), (width / 2, gemini_clean)]:
    for index, value in enumerate(values):
        ax.text(index + offset, value + 0.3, f"{value}/16", ha="center", va="bottom", fontsize=9)
fig3.text(0.04, 0.005, "Same authored worlds and handoff text. API message structure, model, temperature, and sampling time differ; descriptive comparison only.", fontsize=8, color="#555555")
fig3.tight_layout(rect=[0, 0.052, 1, 1])
fig3.savefig(ROOT / "route-model-transfer.png", bbox_inches="tight")
fig3.savefig(ROOT / "route-model-transfer.svg", bbox_inches="tight")
print(ROOT / "route-model-transfer.png")
