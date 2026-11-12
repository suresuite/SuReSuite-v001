# ── Trace helpers (notebook 04) ─────────────────────────────────────────────
# One replication with every item's weeks, and the tables and charts that follow
# several materials through it, with and without a disruption. Run this cell; you do not need to read it.
WORLD_COLORS = ["#2a78d6", "#d9480f"]   # baseline, disrupted
INK, STOCKOUT = "#5f6b7a", "#e03131"


def trace(data, pol, scenario, project_model, seed, bom, disruptions=None):
    """One replication on `seed` → {measure: weeks × items} for materials and for products.
    Materials: on_hand, in_transit, orders, use (+ the MRP record where a material is planned by MRP).
    Products: demand, production, fulfillment, backlog, lost_units, fg_on_hand, …"""
    run, frames = inspect_run(data, pol, scenario, project_model, seed, disruptions)
    out = {"material": {}, "product": {}, "warmup": int(run.get("warmup_detected_at") or 0)}
    for (kind, measure), df in frames.items():
        out.setdefault(kind, {})[measure] = df
    out["material"]["use"] = use_of(frames, bom)
    return out


def material_summary(world, lanes, base=None):
    """One row per material after the warm-up, riskiest first. With `base`, also how far it moved."""
    m, w0 = world["material"], world["warmup"]
    oh, use = m["on_hand"].loc[w0:], m["use"].loc[w0:]
    zero = oh <= 1e-6
    suppliers = lanes.groupby("material_id")["supplier_id"].agg(lambda s: ", ".join(sorted(set(s))))
    t = pd.DataFrame({
        "suppliers": suppliers.reindex(oh.columns).fillna("—"),
        "avg on hand": oh.mean(), "min on hand": oh.min(), "weeks at zero": zero.sum(),
        "first stockout": zero.apply(lambda c: c.idxmax() if c.any() else np.nan),
        "avg in transit": m["in_transit"].loc[w0:].mean(), "avg use / wk": use.mean(),
        "min cover (wk)": oh.min() / use.mean().replace(0, np.nan), "ordered": m["orders"].loc[w0:].sum(),
    }).rename_axis("material")
    t["Δ avg on hand"] = t["avg on hand"] - base["material"]["on_hand"].loc[w0:].mean() if base else 0.0
    order = t.assign(moved=t["Δ avg on hand"].abs() / t["avg on hand"].replace(0, np.nan),
                     cover=t["min cover (wk)"].fillna(np.inf))
    t = t.loc[order.sort_values(["weeks at zero", "moved", "cover"], ascending=[False, False, True]).index]
    return t if base else t.drop(columns="Δ avg on hand")


def select_materials(summary, materials, top_n):
    """The materials named, or the `top_n` riskiest when none is."""
    unknown = sorted(set(materials) - set(summary.index))
    if unknown:
        print("not a material of this run (check the ids):", ", ".join(unknown))
    return [m for m in materials if m in summary.index] or list(summary.index[:top_n])


def baseline(api, source, data, pol, run_scenario, project_model):
    """The baseline: run on this machine ("run"), or a finished platform run pulled by its id.
    A pulled run is only the same baseline when it read the same data, policies, seed and replications."""
    if source == "run":
        return simulate(data, pol, scenario=run_scenario, disruptions=[], project_model=project_model)
    run = api.run(source)
    if run["status"] != "done":
        raise Stop(f"run {source} is {run['status']} — pull a finished run, or set BASELINE = \"run\"")
    sc = next((s for s in api.scenarios(run["project_id"]) if s["id"] == run["scenario_id"]), {})
    differs = [what for what, theirs, mine in [
        ("data", run.get("dataset_version_id"), data.id), ("policies", run.get("policy_version_id"), pol.id),
        ("seed", sc.get("seed"), run_scenario.get("seed")),
        ("replications", run.get("rep_count_done"), run_scenario.get("replications")),
        ("disruptions", bool(sc.get("disruption_schedule")), False)] if theirs != mine]
    print(f"pulled run {source} ({run.get('code_version')})" + (
        f" — NOTE: its {', '.join(differs)} differ from this study's, so a difference from it is not only the disruption"
        if differs else " — same data, policies, seed and replications as this study"))
    return {"run": run, "replications": api.replications(source)}


def compare_table(worlds, lanes, materials):
    """The traced materials, one block of columns per world."""
    cols = ["avg on hand", "min on hand", "weeks at zero", "first stockout", "avg in transit", "ordered"]
    first = material_summary(next(iter(worlds.values())), lanes)
    blocks = {label: material_summary(w, lanes).loc[materials, cols] for label, w in worlds.items()}
    table = pd.concat(blocks, axis=1) if len(blocks) > 1 else next(iter(blocks.values()))
    table.insert(0, "suppliers", first.loc[materials, "suppliers"])
    table.insert(1, "avg use / wk", first.loc[materials, "avg use / wk"])
    return table


DYNAMICS = {"on_hand": "on hand", "in_transit": "in transit", "orders": "ordered / wk", "use": "used / wk"}


def plot_dynamics(worlds, materials, window=None, per_figure=4):
    """Inventory control dynamics: a column per material, a row per measure (on hand, in transit,
    ordered, used), every world drawn over the baseline. Triangles mark weeks with no stock."""
    last = list(worlds.values())[-1]
    for start in range(0, len(materials), per_figure):
        chunk = materials[start:start + per_figure]
        fig, axes = plt.subplots(len(DYNAMICS), len(chunk), figsize=(3.6 * len(chunk) + 0.6, 1.7 * len(DYNAMICS) + 0.8),
                                 sharex=True, squeeze=False)
        for c, m in enumerate(chunk):
            for r, (k, name) in enumerate(DYNAMICS.items()):
                ax = axes[r, c]
                for wi, (label, world) in enumerate(worlds.items()):
                    df = world["material"][k]
                    ax.plot(df.index, df[m], color=WORLD_COLORS[wi % 2], linewidth=1.6, label=label,
                            drawstyle="steps-mid" if k == "orders" else "default")
                if k == "on_hand":
                    oh = last["material"]["on_hand"][m]
                    out = oh.index[(oh <= 1e-6) & (oh.index >= last["warmup"])]
                    ax.scatter(out, [0] * len(out), color=STOCKOUT, marker="v", s=22, zorder=5, label="no stock")
                if window:
                    ax.axvspan(*window, color=INK, alpha=0.12, linewidth=0, label="disruption")
                if last["warmup"]:
                    ax.axvline(last["warmup"], color=INK, linestyle=":", linewidth=1, label="warm-up ends")
                ax.set_ylim(bottom=0)
                ax.tick_params(labelsize=8)
                ax.spines[["top", "right"]].set_visible(False)
                if r == 0:
                    ax.set_title(m, fontsize=9)
                if c == 0:
                    ax.set_ylabel(name, fontsize=8)
            axes[-1, c].set_xlabel("week", fontsize=8)
        handles = {l: h for ax in axes.flat for h, l in zip(*ax.get_legend_handles_labels())}
        fig.legend(handles.values(), handles.keys(), loc="upper center", ncols=len(handles), fontsize=8,
                   frameon=False, bbox_to_anchor=(0.5, 1.0))
        fig.align_ylabels(axes[:, 0])
        plt.tight_layout(rect=(0, 0, 1, 0.95))
        plt.show()


def weekly(worlds, materials):
    """The traced materials as one long table: world · material · measure · week · value."""
    return pd.concat([df[materials].rename_axis("week").reset_index()
                      .melt(id_vars="week", var_name="material", value_name="value").assign(world=label, measure=measure)
                      for label, world in worlds.items() for measure, df in world["material"].items()
                      if set(materials) <= set(df)])[["world", "material", "measure", "week", "value"]]
