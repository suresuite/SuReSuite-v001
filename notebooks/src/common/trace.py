# ── Trace helpers (notebook 04) ─────────────────────────────────────────────
# One replication with every item's weeks, and the tables and charts that follow
# several materials and products through it. Run this cell; you do not need to read it.
import matplotlib.colors as mcolors

WORLD_COLORS = ["#2a78d6", "#d9480f"]   # baseline, disrupted
MEASURE_COLORS = ["#2a78d6", "#7a5af8", "#94a3b8", "#0f766e", "#eda100"]
MEASURE_STYLES = ["-", "--", ":", "-."]
INK, STOCKOUT = "#5f6b7a", "#e03131"


def versions_table(api, project_id, data, pol, scenario, frame):
    """What the runs read, and whether each is the newest the platform has."""
    from sim_worker.build import code_version
    newest = lambda rows: max(rows, key=lambda v: v.get("created_at") or "")["id"] if rows else None
    try:
        engine_latest = api.engine().get("engine_version")
    except SuReSuiteError:  # the offline demo hands out no engine
        engine_latest = None
    build = code_version()
    is_latest = lambda mine, latest: "—" if latest is None else ("yes" if mine == latest else f"no — latest is {latest}")
    return pd.DataFrame([
        ("engine", build, is_latest(build.split("+")[0].removeprefix("scsim-"), engine_latest)),
        ("data", f"v{data.version_no} · {data.label} · graph_hash {str(data.graph_hash)[:12]}",
         is_latest(data.id, newest(api.dataset_versions(project_id)))),
        ("policies", f"{pol.label} · policy_hash {str(pol.policy_hash)[:12]}" if pol.policy_hash else str(pol.label),
         is_latest(pol.id, newest(api.policy_versions(project_id))) if pol.policy_hash else "not saved"),
        ("scenario", f"{scenario['name']} · {frame.get('horizon_days')} days · {frame.get('replications')} replications "
                     f"· seed {frame.get('seed')}", "—"),
    ], columns=["", "version", "latest"]).set_index("")


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


def product_summary(world):
    p, w0 = world["product"], world["warmup"]
    total = lambda k: p[k].loc[w0:].sum() if k in p else np.nan
    t = pd.DataFrame({"demand": total("demand"), "produced": total("production"), "delivered": total("fulfillment"),
                      "lost units": total("lost_units"),
                      "peak backlog": p["backlog"].loc[w0:].max() if "backlog" in p else np.nan})
    t["fill rate %"] = 100 * t["delivered"] / t["demand"].replace(0, np.nan)
    return t.rename_axis("product")


def select_items(summary, bom, products, materials, top_n):
    """The materials and products to follow: the ones named, plus the `top_n` riskiest materials of the
    named products (of the whole project when nothing is named)."""
    known_p = set(bom.product_id)
    unknown = sorted((set(materials) - set(summary.index)) | (set(products) - known_p))
    if unknown:
        print("not in this run (check the ids):", ", ".join(unknown))
    products = [p for p in products if p in known_p]
    named = [m for m in materials if m in summary.index]
    scope = set(bom.material_id[bom.product_id.isin(products)]) if products else set(summary.index)
    auto = [m for m in summary.index if m in scope and m not in named][:top_n] if products or not named else []
    return named + auto, products or sorted(set(bom.product_id[bom.material_id.isin(named + auto)]))


def plot_items(worlds, kind, items, measures, window=None, ncols=3, title=None):
    """Small multiples, one panel per item. `worlds` is {label: trace}. One world: a colour per
    measure. Two worlds: a colour per world and a line style per measure. Triangles mark weeks
    with no stock on hand (in the last world)."""
    items = [i for i in items if any(i in w[kind].get(k, ()) for w in worlds.values() for k in measures)]
    if not items:
        print(f"nothing to plot for {kind}s")
        return
    ncols = min(ncols, len(items))
    nrows = -(-len(items) // ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(4.2 * ncols, 2.4 * nrows + 0.6), sharex=True, squeeze=False)
    last = list(worlds.values())[-1]
    for ax, item in zip(axes.flat, items):
        for wi, (label, world) in enumerate(worlds.items()):
            for mi, k in enumerate(measures):
                df = world[kind].get(k)
                if df is None or item not in df:
                    continue
                one = len(worlds) == 1
                ax.plot(df.index, df[item], linewidth=1.8 if mi == 0 else 1.2,
                        color=MEASURE_COLORS[mi % len(MEASURE_COLORS)] if one else WORLD_COLORS[wi % 2],
                        linestyle="-" if one else MEASURE_STYLES[mi % len(MEASURE_STYLES)],
                        label=k.replace("_", " ") if one else f"{k.replace('_', ' ')} · {label}")
        if kind == "material" and "on_hand" in measures:
            oh = last[kind]["on_hand"][item]
            out = oh.index[(oh <= 1e-6) & (oh.index >= last["warmup"])]
            ax.scatter(out, [0] * len(out), color=STOCKOUT, marker="v", s=22, zorder=5, label="no stock")
        if window:
            ax.axvspan(*window, color=INK, alpha=0.12, linewidth=0, label="disruption")
        if last["warmup"]:
            ax.axvline(last["warmup"], color=INK, linestyle=":", linewidth=1, label="warm-up ends")
        ax.set_title(item, fontsize=9)
        ax.set_ylim(bottom=0)
        ax.tick_params(labelsize=8)
        ax.spines[["top", "right"]].set_visible(False)
    for ax in axes.flat[len(items):]:
        ax.set_visible(False)
    for ax in axes[-1]:
        ax.set_xlabel("week", fontsize=8)
    handles = {l: h for ax in axes.flat for h, l in zip(*ax.get_legend_handles_labels())}
    fig.legend(handles.values(), handles.keys(), loc="upper center", ncols=min(len(handles), 6), fontsize=8,
               frameon=False, bbox_to_anchor=(0.5, 1.0))
    fig.suptitle(title or f"{kind}s — units per week", fontsize=10, y=1.06)
    plt.tight_layout()
    plt.show()


def stock_map(world, items, base=None, window=None):
    """Every traced material on one chart, a row each, week by week. Baseline only: stock on hand as a
    share of that material's own peak (white = empty). With `base`: this world minus the baseline, as a
    share of the baseline average (red = less stock, blue = more)."""
    oh = world["material"]["on_hand"][items]
    if base:
        b = base["material"]["on_hand"][items]
        z = (oh - b) / b.loc[world["warmup"]:].mean().replace(0, np.nan)
        lim = float(min(1.0, max(np.nanmax(np.abs(z.to_numpy())), 0.01)))
        look = {"cmap": "RdBu", "norm": mcolors.TwoSlopeNorm(0, -lim, lim)}
        title, fmt = "Stock on hand: disrupted minus baseline, as a share of the baseline average", "{x:+.0%}"
    else:
        z = oh / oh.max().replace(0, np.nan)
        look = {"cmap": "Blues", "vmin": 0, "vmax": 1}
        title, fmt = "Stock on hand, as a share of each material's own peak", "{x:.0%}"
    fig, ax = plt.subplots(figsize=(11, 0.32 * len(items) + 1.4))
    im = ax.imshow(z.T.to_numpy(), aspect="auto", extent=[-0.5, z.index.max() + 0.5, len(items) - 0.5, -0.5], **look)
    ax.set_yticks(range(len(items)), items, fontsize=8)
    for x in window or ():
        ax.axvline(x, color="#212529", linewidth=0.8, linestyle="--")
    ax.set_xlabel("week")
    ax.set_title(title, fontsize=10)
    fig.colorbar(im, ax=ax, shrink=0.8, format=fmt)
    plt.tight_layout()
    plt.show()


def weekly(worlds, materials, products):
    """The traced items as one long table: world · kind · item · measure · week · value."""
    parts = []
    for label, world in worlds.items():
        for kind, items in (("material", materials), ("product", products)):
            for measure, df in world[kind].items():
                cols = [i for i in items if i in df]
                if cols:
                    parts.append(df[cols].rename_axis("week").reset_index()
                                 .melt(id_vars="week", var_name="item", value_name="value")
                                 .assign(world=label, kind=kind, measure=measure))
    return pd.concat(parts)[["world", "kind", "item", "measure", "week", "value"]]
