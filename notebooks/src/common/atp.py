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


def _parts(worlds, ev, material):
    """Weeks × scenarios for one material: stock at the start of each week, what production uses in
    it, and the lowest point of the week — start less use, because the engine produces before it
    receives. Also says so when the use worked out from the BOM is more than the stock held."""
    opening = next((m.get("initial_on_hand") for m in ev["network"]["materials"] if m["id"] == material), None) or 0.0
    oh = pd.DataFrame({s: w["on_hand"][material] for s, w in worlds.items()})
    use = pd.DataFrame({s: w["use"][material] for s, w in worlds.items()})
    start = oh.shift(1).fillna(opening)
    short = ((start - use) < -0.01 * max(float(oh.to_numpy().mean()), 1.0)).to_numpy().mean()
    if short > 0.02:
        print(f"note: {material} — production's use, worked out from the BOM, is more than the stock held in "
              f"{short:.0%} of weeks. Its ATP is 0 there and may be understated: check its BOM rates.")
    return {"on_hand": oh, "start": start, "use": use, "low": start - use}


def _window_min(low, lead):
    """For each week, the lowest point from that week to one lead time later, when a reorder placed then can land."""
    return pd.DataFrame({w: low.iloc[w:min(w + lead, len(low) - 1) + 1].min() for w in low.index}).T


def _hold(free, confidence):
    """Per week, the amount that is free in at least `confidence` of the scenarios (a real scenario's value)."""
    return free.quantile(1 - confidence, axis=1, interpolation="higher").clip(lower=0)


def atp_position(worlds, ev, week, confidence):
    """Every material at `week`: stock, use, lead time, and what is available to promise — least cover first."""
    lead, sup = lead_times(ev)
    opening = {m["id"]: m.get("initial_on_hand") for m in ev["network"]["materials"]}
    q, rows = 1 - confidence, []
    for m in next(iter(worlds.values()))["on_hand"].columns:
        parts = _parts(worlds, ev, m)
        oh = parts["on_hand"]
        use = np.mean([w["use"][m].mean() for w in worlds.values()])
        atp = _hold(_window_min(parts["low"], lead.get(m) or 2), confidence).loc[week]
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
    """Available to promise in each week, before any request is taken."""
    lead, _ = lead_times(ev)
    return _hold(_window_min(_parts(worlds, ev, material)["low"], lead.get(material) or 2), confidence)


def plan_requests(worlds, ev, requests, confidence):
    """Sort each request into its case and propose a plan for it. Returns (the screen: case and plan
    per request · how each ATP is worked out · {request: {week: units}}).

    ATP in a week = stock at the start of the week
                    + what arrives before the tightest week
                    − what production uses up to and including the tightest week
                    − what earlier requests were promised
    The tightest week is the one, from the request's week to one lead time later (when a reorder
    placed in that week can land), where that sum is lowest. It is read in the scenario that makes
    the promise hold in at least `confidence` of them.

    Case 1, the request is within ATP: all of it in the week.
    Case 2, above ATP: what ATP covers in the week, and the rest in the first week — late enough
    for a reorder to have landed — whose ATP covers the rest.
    Requests for one material are taken in order of their week; an accepted quantity is off the
    stock until a reorder can make it up."""
    lead, _ = lead_times(ev)
    rows, how, plans = {}, {}, {}
    for m, mine in requests.sort_values("week", kind="stable").groupby("material", sort=False):
        L = lead.get(m) or 2
        parts = _parts(worlds, ev, m)
        promised = pd.Series(0.0, index=parts["low"].index)
        left = lambda: parts["low"].sub(promised, axis=0)

        def take(week, units):   # off the stock from that week until a reorder placed then has landed
            promised.loc[week:week + L] += units

        for r, (Q, week) in mine[["quantity", "week"]].iterrows():
            week = int(week)
            window = left().iloc[week:min(week + L, len(promised) - 1) + 1]
            free = window.min()                                        # per scenario
            have = float(max(free.quantile(1 - confidence, interpolation="higher"), 0))
            sc = (free - free.quantile(1 - confidence, interpolation="higher")).abs().idxmin()
            tight = int(window[sc].idxmin())
            start, used = float(parts["start"].loc[week, sc]), float(parts["use"].loc[week:tight, sc].sum())
            how[r] = {"material": m, "week": week, "lead time (wk)": L, "tightest week": tight,
                      "stock at week start": start, "+ arriving before the tightest week": max(float(parts["low"].loc[tight, sc]) - start + used, 0.0),
                      "− production uses until then": used, "− promised to earlier requests": float(promised.loc[tight]),
                      "= ATP": have}
            if Q <= have + 0.5:
                case, plans[r], text = "1 · within ATP", {week: Q}, f"{Q:,.0f} in week {week}"
                take(week, Q)
            else:
                part = float(np.floor(have))
                take(week, part)
                atp = _hold(_window_min(left(), L), confidence)
                later = next((w for w in atp.index if w > week + L and atp.loc[w] >= Q - part), None)
                if later is not None:
                    take(later, Q - part)
                plans[r] = {w: u for w, u in ((week, part), (later, Q - part)) if w is not None and u > 0}
                text = (f"{part:,.0f} in week {week}" if part > 0 else f"nothing in week {week}") + (
                    f", {Q - part:,.0f} in week {later}" if later is not None else "; no week takes the rest")
                case = "2 · above ATP"
            rows[r] = {"material": m, "requested": Q, "week": week, "ATP": have, "case": case, "plan": text}
    table = lambda d: pd.DataFrame.from_dict(d, orient="index").rename_axis("request").loc[requests.index]
    return table(rows), table(how), {r: p for r, p in plans.items() if p}


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
    if not plans:
        print("nothing is planned, so there is nothing to simulate")
        return worlds, None
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
    after = after or before
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
    for r in screen.index.difference(list(rows)):                          # nothing could be planned
        rows[r] = {"material": screen.loc[r, "material"], "case": screen.loc[r, "case"],
                   "decision": f"Decline: nothing is available to promise in week {screen.loc[r, 'week']}, or later",
                   "ATP": screen.loc[r, "ATP"], "delivered as planned": "—", "complete by": "—", "check": "—"}
    table = pd.DataFrame.from_dict(rows, orient="index").rename_axis("request").loc[screen.index]
    return table, customers if plans else "", pd.DataFrame(detail, columns=["material"] if not detail else None).set_index("material")


def plot_decision(before, after, ev, screen, plans, confidence, per_figure=3):
    """A column per material. Top: stock as it is and with the plan. Bottom, on its own scale: what is
    available to promise each week, and the plan's parts as dots."""
    plans = _by_material(screen, plans)
    mats = list(dict.fromkeys(screen["material"]))
    plain = lambda ax: ax.yaxis.set_major_formatter(lambda v, _: f"{v:,.0f}")
    for i in range(0, len(mats), per_figure):
        chunk = mats[i:i + per_figure]
        fig, axes = plt.subplots(2, len(chunk), figsize=(4.6 * len(chunk) + 0.8, 5.0), sharex=True, squeeze=False)
        for c, m in enumerate(chunk):
            top, low = axes[0, c], axes[1, c]
            oh = pd.DataFrame({s: w["on_hand"][m] for s, w in before.items()})
            top.fill_between(oh.index, oh.quantile(0.1, axis=1), oh.quantile(0.9, axis=1), color=ATP_COLORS["stock"],
                             alpha=0.15, linewidth=0)
            top.plot(oh.index, oh.median(axis=1), color=ATP_COLORS["stock"], linewidth=2.2,
                     label="stock as it is (median, 10th–90th band)")
            if m in plans and after is not None:
                with_plan = pd.DataFrame({s: w["on_hand"][m] for s, w in after.items()}).median(axis=1)
                top.plot(with_plan.index, with_plan, color=ATP_COLORS["request"], linewidth=1.2, linestyle="--",
                         label="stock with the plan (median)")
            atp = _atp(before, ev, m, confidence)
            low.step(atp.index, atp.values, where="post", color=ATP_COLORS["atp"], linewidth=1.6, label="available to promise")
            asked = screen[screen["material"] == m]
            low.scatter(asked["week"], asked["requested"], facecolors="none", edgecolors=ATP_COLORS["request"], s=40,
                        zorder=5, label="requested")
            if m in plans:
                low.scatter(list(plans[m]), list(plans[m].values()), color=ATP_COLORS["request"], zorder=6, s=40, label="accepted")
            top.set_title(m, fontsize=9)
            for ax, name in ((top, "stock"), (low, "ATP and requests")):
                ax.set_ylim(bottom=0)
                plain(ax)
                ax.tick_params(labelsize=8)
                ax.spines[["top", "right"]].set_visible(False)
                if c == 0:
                    ax.set_ylabel(name, fontsize=8)
            low.set_xlabel("week", fontsize=8)
        handles = {l: h for ax in axes.flat for h, l in zip(*ax.get_legend_handles_labels())}
        fig.legend(handles.values(), handles.keys(), loc="upper center", ncols=len(handles), fontsize=8, frameon=False,
                   bbox_to_anchor=(0.5, 1.0))
        plt.tight_layout(rect=(0, 0, 1, 0.94))
        plt.show()
