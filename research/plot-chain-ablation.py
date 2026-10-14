import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent
delivery = json.loads((ROOT / "chain-b-ablation-summary.json").read_text(encoding="utf-8"))
mechanism = json.loads((ROOT / "chain-b-mechanism-summary.json").read_text(encoding="utf-8"))

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(1, 2, figsize=(11.7, 4.9), dpi=180, gridspec_kw={"width_ratios": [1.15, 1]})

delivery_arms = ["original-user", "original-system", "conditional-user", "conditional-system", "compiled-state"]
delivery_labels = ["Original\nuser", "Original\nsystem", "Conditional\nuser", "Conditional\nsystem", "Compiled\nstate"]
values = [delivery["cohorts"][f"after|{arm}"]["correctWholeLabel"] for arm in delivery_arms]
colors = ["#9A635E", "#9A635E", "#75806E", "#75806E", "#596A82"]
axes[0].bar(np.arange(5), values, color=colors, width=0.66)
axes[0].set_xticks(np.arange(5), delivery_labels)
axes[0].set_title("Instruction and handoff channel", loc="left", fontsize=12, weight="semibold")

mechanism_arms = ["vague-plain", "vague-format", "branch-plain", "branch-format"]
mechanism_labels = ["Vague\nplain", "Vague\nformat rule", "Branch table\nplain", "Branch table\nformat rule"]
values2 = [mechanism["cohorts"][f"{arm}|after"]["correctWholeLabel"] for arm in mechanism_arms]
axes[1].bar(np.arange(4), values2, color=["#9A635E", "#9A635E", "#75806E", "#75806E"], width=0.66)
axes[1].set_xticks(np.arange(4), mechanism_labels)
axes[1].set_title("Decision rule and format reminder", loc="left", fontsize=12, weight="semibold")

for ax, scores in zip(axes, [values, values2]):
    ax.set_ylim(0, 9.5)
    ax.set_yticks([0, 2, 4, 6, 8])
    ax.set_ylabel("Correct whole-label B replies / 8")
    ax.grid(axis="y", alpha=0.16)
    ax.set_axisbelow(True)
    for x, score in enumerate(scores):
        ax.text(x, score + 0.23, f"{score}/8", ha="center", va="bottom", fontsize=9)

fig.text(0.03, 0.005, "GPT-OSS 20B via Groq. Eight authored worlds per condition, one call per world. Both studies had 8/8 exact pre-handoff waits in every instruction arm; no provider errors. Descriptive only.", fontsize=8, color="#555555")
fig.tight_layout(rect=[0, 0.055, 1, 0.99], w_pad=2.6)
fig.savefig(ROOT / "chain-b-ablation.png", bbox_inches="tight")
fig.savefig(ROOT / "chain-b-ablation.svg", bbox_inches="tight")
print(ROOT / "chain-b-ablation.png")
