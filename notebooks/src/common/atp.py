# ── Available-to-promise helpers (notebook 05) ──────────────────────────────
# Runs the chain as it is in several scenarios (kept on disk, so a new question costs no new
# run), sorts each request into its case from what is available to promise, and simulates the
# resulting plan to give the answer. Run this cell; you do not need to read it.
import pickle

ATP_COLORS = {"stock": "#2a78d6", "atp": "#008300", "request": "#d9480f"}


ISSUE = "ATP-ISSUE"   # the customer row, and the prefix of the stand-in products, that take accepted material out


def futures(data, pol, run, model, seeds, bom, cache_dir="suresuite_cache/futures"):
    """One replication per seed → {seed: {measure: weeks × items}}: each material's stock on hand, in
    transit, ordered and used, and each product's deliveries and lost units. A scenario depends only on
    the engine, the data, the policies, the frame and its seed, so each is saved under a key made of
    those and read back on the next run: changing the materials, quantities, dates or confidence runs
    nothing, and raising the number of scenarios runs only the new seeds."""
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
                  "orders": frames[("material", "orders")], "use": use_of(frames, bom),
                  "delivered": frames[("product", "fulfillment")], "lost": frames[("product", "lost_units")]}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pickle.dumps(out[s]))
        ran += 1
    print(f"{len(seeds)} scenarios: {ran} run, {len(seeds) - ran} from the cache — {time.time() - started:.1f}s")
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


def _trough(worlds, ev, material):
    """(on hand, the lowest point of each week), both weeks × scenarios. The engine produces before it
    receives, so what a week can give up is its opening stock less what production uses that week."""
    opening = next((m.get("initial_on_hand") for m in ev["network"]["materials"] if m["id"] == material), None) or 0.0
    oh = pd.DataFrame({s: w["on_hand"][material] for s, w in worlds.items()})
    use = pd.DataFrame({s: w["use"][material] for s, w in worlds.items()})
    return oh, oh.shift(1).fillna(opening) - use


def _window_min(trough, lead):
    """For each week, the lowest point from that week to one lead time later, when a reorder placed then can land."""
    return pd.DataFrame({w: trough.iloc[w:min(w + lead, len(trough) - 1) + 1].min() for w in trough.index}).T.clip(lower=0)


def _free(worlds, ev, material, lead):
    """(on hand, free stock), both weeks × scenarios: what can leave in a week without production running
    short before a reorder can arrive."""
    oh, trough = _trough(worlds, ev, material)
    return oh, _window_min(trough, lead)


def atp_position(worlds, ev, week, confidence):
    """Every material at `week`: stock, use, lead time, and what is available to promise — least cover first."""
    lead, sup = lead_times(ev)
    opening = {m["id"]: m.get("initial_on_hand") for m in ev["network"]["materials"]}
    q, rows = 1 - confidence, []
    for m in next(iter(worlds.values()))["on_hand"].columns:
        oh, free = _free(worlds, ev, m, lead.get(m) or 2)
        use = np.mean([w["use"][m].mean() for w in worlds.values()])
        atp = free.loc[week].quantile(q)
        rows.append({"material": m, "suppliers": ", ".join(sorted(sup.get(m, []))) or "—", "opening stock": opening.get(m),
                     "on hand (median)": oh.loc[week].median(), f"on hand (low, {q:.0%})": oh.loc[week].quantile(q),
                     "in transit (median)": np.median([w["in_transit"][m].loc[week] for w in worlds.values()]),
                     "use / wk": use, "lead time (wk)": lead.get(m) or 2, "ATP": atp,
                     "ATP cover (wk)": atp / use if use else np.nan})
    t = pd.DataFrame(rows).set_index("material")
    return t.loc[t["ATP cover (wk)"].fillna(np.inf).sort_values(kind="stable").index]


def read_requests(requests, position, start, horizon, top_n, quantity, week):
    """The requests as a table, one row each: material · quantity · week · date. A request is
    (material, quantity, when); `when` is a week number or a "YYYY-MM-DD" date. With none given, the
    `top_n` materials with the least cover, `quantity` each in `week`. A line that cannot be read is
    reported and left out."""
    lines = list(requests) or [(m, quantity, week) for m in position.index[:top_n]]
    rows = []
    for i, line in enumerate(lines, 1):
        try:
            m, q, when = line
            w = int(when) if not isinstance(when, str) else int((pd.Timestamp(when) - start).days // 7)
            q = float(q)
        except (TypeError, ValueError):
            print(f"request {i}: expected (material, quantity, week or date), got {line!r} — left out")
            continue
        problem = ("not a material the engine received" if m not in position.index else
                   "the quantity must be above zero" if q <= 0 else
                   f"week {w} is outside the simulated weeks 0–{horizon - 1}" if not 0 <= w < horizon else None)
        if problem:
            print(f"request {i} ({m}): {problem} — left out")
            continue
        rows.append({"request": len(rows) + 1, "material": m, "quantity": q, "week": w,
                     "date": (start + pd.Timedelta(weeks=w)).date()})
    if not rows:
        raise Stop("no request could be read — check REQUESTS in the settings cell")
    return pd.DataFrame(rows).set_index("request")


def _atp(worlds, ev, material, confidence):
    """Available to promise in each week: the free stock that holds in at least `confidence` of the scenarios."""
    lead, _ = lead_times(ev)
    return _free(worlds, ev, material, lead.get(material) or 2)[1].quantile(1 - confidence, axis=1)


def plan_requests(worlds, ev, requests, confidence):
    """Sort each request into its case and propose a plan for it. Returns (the screen table, a row per
    request · {request: {week: units}}).
    Case 1, the request is within ATP: all of it in the week.
    Case 2, above ATP: what ATP covers in the week, and the rest in the first week — late enough
    for a reorder to have landed — whose ATP covers the rest.
    Requests for one material are taken in order of their week, and each sees what is left after
    the ones before it: an accepted quantity is off the stock until a reorder can make it up."""
    lead, _ = lead_times(ev)
    rows, plans = {}, {}
    for m, mine in requests.sort_values("week", kind="stable").groupby("material", sort=False):
        L = lead.get(m) or 2
        trough = _trough(worlds, ev, m)[1]
        atp = lambda: _window_min(trough, L).quantile(1 - confidence, axis=1)

        def take(week, units):   # off the stock from that week until a reorder placed then has landed
            trough.loc[week:week + L] -= units

        for r, (Q, week) in mine[["quantity", "week"]].iterrows():
            week, have = int(week), float(atp().loc[week])
            if Q <= have + 0.5:
                case, plans[r], text = "1 · within ATP", {week: Q}, f"{Q:,.0f} in week {week}"
                take(week, Q)
            else:
                part = float(np.floor(have))
                take(week, part)
                left = atp()
                later = next((w for w in left.index if w > week + L and left.loc[w] >= Q - part), None)
                if later is not None:
                    take(later, Q - part)
                plans[r] = {w: u for w, u in ((week, part), (later, Q - part)) if w is not None and u > 0}
                text = (f"{part:,.0f} in week {week}" if part > 0 else f"nothing in week {week}") + (
                    f", {Q - part:,.0f} in week {later}" if later is not None else "; no week takes the rest")
                case = "2 · above ATP"
            rows[r] = {"material": m, "requested": Q, "week": week, "ATP": have, "case": case, "plan": text}
    screen = pd.DataFrame.from_dict(rows, orient="index").rename_axis("request").loc[requests.index]
    return screen, {r: p for r, p in plans.items() if p}


def _by_material(screen, plans):
    """{material: {week: units}} — every planned part of every request for the material."""
    out = {}
    for r, plan in plans.items():
        total = out.setdefault(screen.loc[r, "material"], {})
        for w, u in plan.items():
            total[w] = total.get(w, 0.0) + u
    return out


def accept(data, pol, plans):
    """A copy of the data and policies with the planned material taken out of stock. The engine issues
    material only through production, so each material gets a stand-in product that uses one unit of
    it and one firm order with the plan's deliveries, waiting if the stock is not there. Returns
    (data, policies with the orders at zero, policies with the orders): the first pair is the
    reference, so the two runs draw the same random numbers and differ only by the decision."""
    pid = lambda m: f"{ISSUE}::{m}"
    inputs = data.snapshot.get("inputs") if isinstance(data.snapshot.get("inputs"), dict) else data.snapshot
    rows = lambda name: list(inputs.get(name) or [])   # the stored rows, so no column gains an empty value
    bom_table = "bom_multi_level" if rows("bom_multi_level") else "bom"
    data2 = with_tables(data, **{
        "products": rows("products") + [{"product_id": pid(m), "name": f"issue of {m}", "fulfillment_mode": "mto",
                                         "production_capacity": 1e9, "sell_price": 0} for m in plans],
        "outbound": rows("outbound") + [{"customer_id": ISSUE, "product_id": pid(m), "volume": 1e-6, "time_unit": "week",
                                         "unit_price": 0, "expected_lead_time": 0} for m in plans],
        bom_table: rows(bom_table) + [{"product_id": pid(m), "material_id": m, "consumption_rate": 1} for m in plans]})

    def policies(ordering):
        snap = copy.deepcopy(pol.snapshot)
        for m, plan in plans.items():
            schedule = [float(plan.get(w, 0.0)) if ordering else 0.0 for w in range(max(plan) + 1)]
            snap.setdefault("overrides", []).extend([
                {"scope": "node", "target_key": f"{ISSUE}::{pid(m)}", "family": "demand",
                 "patch": {"row_demand_schedule": schedule}},
                {"scope": "node", "target_key": f"{ISSUE}::{pid(m)}", "family": "fulfillment",
                 "patch": {"backorder_allowed": True, "max_backorder_days": 182}}])
        return Policy(id=pol.id, policy_hash=None, snapshot=snap, label="with the plan")

    return data2, policies(False), policies(True)


def decide(worlds, data, pol, run, model, seeds, screen, plans):
    """(the scenarios without the plan, the scenarios with it), on the same seeds. The copy with its
    orders at zero is run for the first seed only: when it reproduces the chain as it is — it should,
    the stand-in rows order nothing — the scenarios already held are the reference and no more are run."""
    data2, pol_zero, pol_plan = accept(data, pol, _by_material(screen, plans))
    bom2 = flat_bom(input_tables(data2))
    first = inspect_run(data2, pol_zero, run, model, seeds[0])[1][("material", "on_hand")]
    same = np.allclose(first[worlds[seeds[0]]["on_hand"].columns], worlds[seeds[0]]["on_hand"])
    if not same:
        print("the copy does not reproduce the chain as it is, so its own reference is run")
    return (worlds if same else futures(data2, pol_zero, run, model, seeds, bom2)), futures(data2, pol_plan, run, model, seeds, bom2)


def decision(before, after, screen, plans, confidence):
    """The answer. Returns (a row per request: material, case, decision, ATP, delivered as planned,
    complete by, check · one sentence on existing customers · the detail per material, for the export).
    A material's deliveries serve its requests in order of their weeks."""
    n, q, rows, detail = len(after), 1 - confidence, {}, []
    stat = lambda ws, f: pd.Series({s: f(w) for s, w in ws.items()})
    for m, total in _by_material(screen, plans).items():
        first = min(total)
        got = pd.DataFrame({s: w["delivered"][f"{ISSUE}::{m}"].cumsum() for s, w in after.items()})
        due = pd.Series(total).sort_index().cumsum()                     # units owed by each planned week
        empty = lambda ws: stat(ws, lambda w: (w["on_hand"][m].loc[first:] <= 1e-6).sum()).median()
        low = lambda ws: stat(ws, lambda w: w["on_hand"][m].loc[first:].min()).quantile(q)
        ordered = lambda ws: stat(ws, lambda w: w["orders"][m].loc[first:].sum()).median()
        more_empty = empty(after) - empty(before)
        for r in [r for r in plans if screen.loc[r, "material"] == m]:
            tol = max(0.5, 0.001 * sum(plans[r].values()))
            as_planned = pd.concat([got.loc[w] >= due.loc[w] - tol for w in plans[r]], axis=1).all(axis=1)
            when = got.ge(due.loc[max(plans[r])] - tol).apply(lambda c: c.idxmax() if c.any() else np.nan)
            by = when.quantile(confidence, interpolation="higher") if when.notna().mean() >= confidence else np.nan
            problems = (["late"] if as_planned.mean() < confidence else []) + (
                [f"stock runs out {more_empty:,.0f} more week(s)"] if more_empty >= 1 else [])
            rows[r] = {"material": m, "case": screen.loc[r, "case"], "decision": "Accept " + screen.loc[r, "plan"],
                       "ATP": screen.loc[r, "ATP"], "delivered as planned": f"{int(as_planned.sum())} of {n} scenarios",
                       "complete by": f"week {int(by)}" if by == by else "not within the horizon",
                       "check": "ok" if not problems else ", ".join(problems)}
        detail.append({"material": m, "accepted": sum(total.values()),
                       "lowest stock after · as is": low(before), "lowest stock after · with the plan": low(after),
                       "weeks with no stock · as is": empty(before), "weeks with no stock · with the plan": empty(after),
                       "ordered after · as is": ordered(before), "ordered after · with the plan": ordered(after)})
    real = [p for p in next(iter(before.values()))["lost"].columns if not p.startswith(ISSUE)]
    extra = pd.Series({s: after[s]["lost"][real].to_numpy().sum() - before[s]["lost"][real].to_numpy().sum() for s in before})
    hurt = extra[extra > 0.5]
    customers = "Existing customers lose nothing to it." if hurt.empty else (
        f"Existing customers lose about {hurt.median():,.0f} units to it, in {len(hurt)} of {n} scenarios.")
    table = pd.DataFrame.from_dict(rows, orient="index").rename_axis("request").loc[[r for r in screen.index if r in rows]]
    return table, customers, pd.DataFrame(detail).set_index("material")


def plot_decision(before, after, ev, screen, plans, confidence):
    """A panel per material: stock as it is and with the plan, what is available to promise, and the plan's parts."""
    plans = _by_material(screen, plans)
    mats = list(plans)
    ncols = min(2, len(mats))
    nrows = -(-len(mats) // ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(5.5 * ncols, 2.7 * nrows + 0.6), sharex=True, squeeze=False)
    for ax, m in zip(axes.flat, mats):
        oh = pd.DataFrame({s: w["on_hand"][m] for s, w in before.items()})
        ax.fill_between(oh.index, oh.quantile(0.1, axis=1), oh.quantile(0.9, axis=1), color=ATP_COLORS["stock"], alpha=0.15,
                        linewidth=0)
        ax.plot(oh.index, oh.median(axis=1), color=ATP_COLORS["stock"], linewidth=1.6, label="stock as it is (median, 10th–90th band)")
        with_plan = pd.DataFrame({s: w["on_hand"][m] for s, w in after.items()}).median(axis=1)
        ax.plot(with_plan.index, with_plan, color=ATP_COLORS["request"], linewidth=1.6, label="stock with the plan (median)")
        atp = _atp(before, ev, m, confidence)
        ax.step(atp.index, atp.values, where="post", color=ATP_COLORS["atp"], linewidth=1.6, label="available to promise")
        ax.scatter(list(plans[m]), list(plans[m].values()), color=ATP_COLORS["request"], zorder=5, s=40, label="accepted")
        ax.set_title(f"{m} — " + ", ".join(f"{u:,.0f} in week {w}" for w, u in sorted(plans[m].items())), fontsize=9)
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
