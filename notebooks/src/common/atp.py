# ── Available-to-promise helpers (notebook 05) ──────────────────────────────
# Runs the chain as it is in several futures (kept on disk, so a new question costs no new
# run), and reads from each material's stock what can be promised and when. Run this cell;
# you do not need to read it.
import pickle

ATP_COLORS = {"stock": "#2a78d6", "atp": "#008300", "request": "#d9480f"}
KEPT = ("on_hand", "in_transit", "use")   # what a future keeps per material, week by week


def futures(data, pol, run, model, seeds, bom, cache_dir="suresuite_cache/futures"):
    """One replication per seed → {seed: {measure: weeks × materials}}. A future depends only on the
    engine, the data, the policies, the frame and its seed, so each is saved under a key made of those
    and read back on the next run: changing the materials, quantities, dates or confidence runs nothing,
    and raising the number of futures runs only the new seeds."""
    from sim_worker.build import code_version
    frame = {k: v for k, v in run.items() if k in ("horizon_days", "warmup_days", "warmup_mode", "crn", "recovery_overrides")}
    key = hashlib.sha256(json.dumps([code_version(), data.snapshot, pol.snapshot, frame, model],
                                    sort_keys=True, default=str).encode()).hexdigest()[:16]
    out, ran, started = {}, 0, time.time()
    for s in seeds:
        path = Path(cache_dir) / f"{key}-{s}.pkl"
        if path.exists():
            out[s] = pickle.loads(path.read_bytes())
            continue
        frames = inspect_run(data, pol, run, model, s)[1]
        out[s] = {"on_hand": frames[("material", "on_hand")], "in_transit": frames[("material", "in_transit")],
                  "use": use_of(frames, bom)}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pickle.dumps(out[s]))
        ran += 1
    print(f"{len(seeds)} futures: {ran} run, {len(seeds) - ran} from the cache — {time.time() - started:.1f}s")
    return out


def week_zero(T, start_date):
    """The date of week 0: `start_date`, else your earliest forecast period, else today."""
    fc = T["demand_forecasts"]
    start = pd.Timestamp(start_date) if start_date else (
        pd.to_datetime(col(fc, "period_start")).min() if len(fc) else pd.NaT)
    return pd.Timestamp.today().normalize() if pd.isna(start) else start


def lead_times(ev):
    """Each material's replenishment lead time in weeks, as the engine received it: its primary
    supplier link's, else the shortest. Also its suppliers, quickest first."""
    links = pd.DataFrame(ev["network"]["supplier_links"]).sort_values("lead_time_weeks")
    lead = {}
    for m, ls in links.groupby("material_id"):
        primary = ls[ls["primary"] == True]  # noqa: E712 — a column of booleans
        lead[m] = int((primary if len(primary) else ls)["lead_time_weeks"].min())
    return lead, links.groupby("material_id")["supplier_id"].agg(list).to_dict()


def _free(worlds, material, lead):
    """(on hand, free stock), both weeks × futures. Free stock in a week is the lowest stock from that
    week to one lead time later — what can leave then without running short before a reorder arrives."""
    oh = pd.DataFrame({s: w["on_hand"][material] for s, w in worlds.items()})
    return oh, pd.DataFrame({w: oh.iloc[w:min(w + lead, len(oh) - 1) + 1].min() for w in oh.index}).T


def atp_position(worlds, ev, week, confidence):
    """Every material at `week`: stock, use, lead time, and what is available to promise — least cover first."""
    lead, sup = lead_times(ev)
    opening = {m["id"]: m.get("initial_on_hand") for m in ev["network"]["materials"]}
    q, rows = 1 - confidence, []
    for m in next(iter(worlds.values()))["on_hand"].columns:
        oh, free = _free(worlds, m, lead.get(m) or 2)
        use = np.mean([w["use"][m].mean() for w in worlds.values()])
        atp = free.loc[week].quantile(q)
        rows.append({"material": m, "suppliers": ", ".join(sorted(sup.get(m, []))) or "—", "opening stock": opening.get(m),
                     "on hand (median)": oh.loc[week].median(), f"on hand (low, {q:.0%})": oh.loc[week].quantile(q),
                     "in transit (median)": np.median([w["in_transit"][m].loc[week] for w in worlds.values()]),
                     "use / wk": use, "lead time (wk)": lead.get(m) or 2, "ATP": atp,
                     "ATP cover (wk)": atp / use if use else np.nan})
    t = pd.DataFrame(rows).set_index("material")
    return t.loc[t["ATP cover (wk)"].fillna(np.inf).sort_values(kind="stable").index]


def pick_requests(position, materials, quantity, top_n):
    """{material: quantity} — the materials named (or the `top_n` with the least ATP cover), each with
    `quantity`: one number for all, or a dict by material id."""
    unknown = sorted(set(materials) - set(position.index))
    if unknown:
        print("not a material the engine received (check the ids):", ", ".join(unknown))
    chosen = [m for m in materials if m in position.index] or list(position.index[:top_n])
    amount = lambda m: float(quantity.get(m, 0) if isinstance(quantity, dict) else quantity)
    missing = [m for m in chosen if amount(m) <= 0]
    if missing:
        print("no quantity given for:", ", ".join(missing), "— left out")
    return {m: amount(m) for m in chosen if m not in missing}


def promise(worlds, ev, lanes, requests, week, confidence, start):
    """The answer per material: can `quantity` leave stock in `week`, in at least `confidence` of the futures?
    If not: how much can, when the rest, the nearest week that takes all of it, and what ordering now gives."""
    lead, sup = lead_times(ev)
    capacity = {s["id"]: s.get("capacity_per_week") for s in ev["network"]["suppliers"]}
    date = lambda w: f"week {int(w)} ({(start + pd.Timedelta(weeks=int(w))).date()})"
    q, rows = 1 - confidence, []
    for m, Q in requests.items():
        tol = max(0.5, 0.001 * Q)
        _, free = _free(worlds, m, lead.get(m) or 2)
        done = free.ge(Q - tol)
        ok = done.mean(axis=1) >= confidence                      # weeks that take all of it
        on_time = free.clip(upper=Q).loc[week].quantile(q)
        when = done.loc[week:].apply(lambda c: c.idxmax() if c.any() else np.nan)
        rest = when.quantile(confidence, interpolation="higher") if when.notna().mean() >= confidence else np.nan
        later = next((w for w in ok.index[ok] if w > week), None)
        later = later if later is not None else (rest if rest == rest else None)
        earlier = max((w for w in ok.index[ok] if w < week), default=None)
        if ok.loc[week]:
            answer = "yes" + (f" — also from {date(earlier)}" if earlier is not None else "")
        elif on_time >= tol:
            answer = f"partial: {on_time:,.0f} then, the rest " + (f"by {date(rest)}" if rest == rest else "in no week of the horizon")
        else:
            answer = "no"
        s = (sup.get(m) or [None])[0]
        spare = (capacity.get(s) or 0) - lanes[lanes.supplier_id == s]["per_week"].sum() if s else np.nan
        rows.append({"material": m, "quantity": Q, "ATP": free.loc[week].quantile(q),
                     "on time (% of futures)": 100 * done.loc[week].mean(), "answer": answer,
                     "all of it by": "—" if ok.loc[week] else date(later) if later is not None else "no week in the horizon",
                     "or earlier, by": date(earlier) if earlier is not None and not ok.loc[week] else "—",
                     "ordered now, arrives": f"{date(lead.get(m) or 2)} from {s}" if s else "—",
                     "supplier spare / wk": max(spare, 0) if spare == spare else np.nan})
    return pd.DataFrame(rows).set_index("material")


def plot_atp(worlds, ev, requests, week, confidence, per_row=2):
    """A panel per material: stock across the futures, what is available to promise, and the request."""
    lead, _ = lead_times(ev)
    mats = list(requests)
    ncols = min(per_row, len(mats))
    nrows = -(-len(mats) // ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(5.5 * ncols, 2.7 * nrows + 0.6), sharex=True, squeeze=False)
    for ax, m in zip(axes.flat, mats):
        oh, free = _free(worlds, m, lead.get(m) or 2)
        atp = free.quantile(1 - confidence, axis=1)
        ax.fill_between(oh.index, oh.quantile(0.1, axis=1), oh.quantile(0.9, axis=1), color=ATP_COLORS["stock"], alpha=0.15,
                        linewidth=0, label="on hand, 10th–90th percentile")
        ax.plot(oh.index, oh.median(axis=1), color=ATP_COLORS["stock"], linewidth=1.8, label="on hand, median")
        ax.step(atp.index, atp.values, where="post", color=ATP_COLORS["atp"], linewidth=1.8,
                label=f"available to promise ({confidence:.0%})")
        ax.scatter([week], [requests[m]], color=ATP_COLORS["request"], zorder=5, s=40, label="the request")
        ax.axvline(week, color=ATP_COLORS["request"], linewidth=0.8, linestyle=":")
        ax.set_title(f"{m} — {requests[m]:,.0f} in week {week} · lead time {lead.get(m) or 2} wk", fontsize=9)
        ax.set_ylim(bottom=0)
        ax.tick_params(labelsize=8)
        ax.spines[["top", "right"]].set_visible(False)
    for ax in axes.flat[len(mats):]:
        ax.set_visible(False)
    for ax in axes[-1]:
        ax.set_xlabel("week", fontsize=8)
    handles = {l: h for ax in axes.flat for h, l in zip(*ax.get_legend_handles_labels())}
    fig.legend(handles.values(), handles.keys(), loc="upper center", ncols=len(handles), fontsize=8, frameon=False,
               bbox_to_anchor=(0.5, 1.0))
    plt.tight_layout(rect=(0, 0, 1, 0.94))
    plt.show()
