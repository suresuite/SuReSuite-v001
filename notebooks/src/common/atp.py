# ── Available-to-promise helpers (notebook 05) ──────────────────────────────
# Supplier-side ATP: what the suppliers of a material can deliver on top of our planned orders,
# from their weekly capacity. Sorts each request into its case, spreads it across the suppliers,
# and (optionally) simulates the plan. Run this cell; you do not need to read it.
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


def supplier_table(ev, lanes, assume_spare=None, seed=0):
    """One row per supplier and material it delivers: weekly capacity, what our planned orders already
    take from that supplier (all its materials together), what is spare, and the lead time.
    A supplier with no capacity in the data cannot be asked — unless `assume_spare` = (low, high):
    then its capacity is ASSUMED to be what it already delivers plus a buffer, a share of that volume
    drawn between the two (whole units; the same draws for the same `seed`), and the "capacity"
    column says so."""
    cap = {s["id"]: s.get("capacity_per_week") for s in ev["network"]["suppliers"]}
    committed = lanes.groupby("supplier_id")["per_week"].sum()
    t = pd.DataFrame(ev["network"]["supplier_links"])[["material_id", "supplier_id", "lead_time_weeks"]].rename(
        columns={"material_id": "material", "supplier_id": "supplier", "lead_time_weeks": "lead time (wk)"})
    t["capacity / wk"] = pd.to_numeric(t["supplier"].map(cap), errors="coerce")
    t["committed / wk"] = t["supplier"].map(committed).fillna(0.0)
    t["capacity"] = np.where(t["capacity / wk"].notna(), "your data", "not set")
    missing = t["capacity / wk"].isna()
    if assume_spare and missing.any():
        low, high = assume_spare
        names = sorted(t.loc[missing, "supplier"].unique())           # one draw per supplier, in a fixed order
        share = dict(zip(names, np.random.default_rng(seed).uniform(low, high, len(names))))
        buffer = t["supplier"].map(share)
        t.loc[missing, "capacity / wk"] = np.round(t["committed / wk"] * (1 + buffer))[missing]
        t.loc[missing, "capacity"] = [f"assumed: committed + {x:.0%}" for x in buffer[missing]]
        print(f"note: {len(names)} of {t['supplier'].nunique()} suppliers have no capacity in your data — it is ASSUMED: "
              f"what they already deliver plus a buffer of {low:.0%}–{high:.0%} (seed {seed}). Enter real capacities to replace it.")
    t["spare / wk"] = (t["capacity / wk"] - t["committed / wk"]).clip(lower=0)
    return t.sort_values(["material", "supplier"]).reset_index(drop=True)


def _can_deliver(row, week, used):
    """What one supplier can still deliver of a material by `week`: its spare capacity in every week
    it can ship in time (an order placed now, in week 0, arrives one lead time later)."""
    last = week - int(row["lead time (wk)"])
    if last < 0 or pd.isna(row["spare / wk"]):
        return 0.0
    return float((row["spare / wk"] - used[row["supplier"]].loc[0:last]).clip(lower=0).sum())


def read_requests(requests, suppliers, start, horizon, top_n, quantity, week):
    """The requests as a table, one row each: material · quantity · week · date. A request is
    (material, quantity, when); `when` is a week number or a "YYYY-MM-DD" date. With none given, the
    first `top_n` materials, `quantity` each in `week`. A line that cannot be read is reported and
    left out."""
    known = list(dict.fromkeys(suppliers["material"]))
    lines = list(requests) or [(m, quantity, week) for m in known[:top_n]]
    rows = []
    for i, line in enumerate(lines, 1):
        try:
            m, q, when = line
            q = float(q)
        except (TypeError, ValueError):
            print(f"request {i}: expected (material, quantity, week or date), got {line!r} — left out")
            continue
        try:
            w = int(when) if not isinstance(when, str) else int((pd.Timestamp(when) - start).days // 7)
        except (TypeError, ValueError):
            print(f"request {i} ({m}): {when!r} is not a week number or a real date (YYYY-MM-DD) — left out")
            continue
        problem = ("not a material with a supplier in your data" if m not in known else
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


def plan_requests(suppliers, requests, horizon):
    """Sort each request into its case and spread it across the material's suppliers. Returns
    (the answer, a row per request · why, a row per request and supplier · {request: {week: units}}).

    ATP by a week = for each supplier of the material, its spare capacity per week (capacity less
    what our planned orders take) in every week it can ship in time, added over the suppliers.

    Case 1, the request is within ATP: all of it by the week, shared between the suppliers in
    proportion to what each can deliver.
    Case 2, above ATP: everything the suppliers can deliver by the week, and the rest in the first
    later week by which their spare capacity has covered it.
    Requests are taken in order of their week; what one is promised is capacity the next no longer has."""
    used = {s: pd.Series(0.0, index=range(horizon)) for s in suppliers["supplier"].unique()}
    answer, why, plans = {}, [], {}
    for r, (m, Q, week) in requests.sort_values("week", kind="stable")[["material", "quantity", "week"]].iterrows():
        week, rows = int(week), suppliers[suppliers["material"] == m]
        can = {i: _can_deliver(row, week, used) for i, row in rows.iterrows()}
        atp = sum(can.values())
        share = min(Q / atp, 1.0) if atp > 0 else 0.0                 # of what each can deliver by the week
        by_week = {i: can[i] * share for i in can}
        for i, row in rows.iterrows():                                # that share of each week's spare capacity
            if by_week[i] > 0:
                ship = slice(0, week - int(row["lead time (wk)"]))
                used[row["supplier"]].loc[ship] += share * (row["spare / wk"] - used[row["supplier"]].loc[ship]).clip(lower=0)
        rest, after, later = Q - sum(by_week.values()), {i: 0.0 for i in can}, None
        if rest > 0.5:
            trial = {s: u.copy() for s, u in used.items()}
            for t in range(week + 1, horizon):                        # an arrival week, one at a time
                free = {i: max(float(row["spare / wk"] - trial[row["supplier"]].loc[t - int(row["lead time (wk)"])]), 0.0)
                        for i, row in rows.iterrows() if t - int(row["lead time (wk)"]) >= 0 and pd.notna(row["spare / wk"])}
                take = min(rest - sum(after.values()), sum(free.values()))
                for i, f in free.items():
                    if take > 0:
                        part = take * f / sum(free.values())
                        after[i] += part
                        trial[rows.loc[i, "supplier"]].loc[t - int(rows.loc[i, "lead time (wk)"])] += part
                if rest - sum(after.values()) <= 0.5:
                    later, used = t, trial
                    break
            if later is None:
                after = {i: 0.0 for i in can}
        first = sum(by_week.values())
        plans[r] = {w: u for w, u in ((week, first), (later, rest)) if w is not None and u > 0.5}
        case = "1 · within ATP" if rest <= 0.5 else "2 · above ATP"
        if not plans[r]:
            decision = f"Decline: no supplier can deliver by week {week}, or later"
        else:
            decision = (f"Accept all {Q:,.0f} by week {later}; nothing can arrive by week {week}" if first <= 0.5 else
                        f"Accept {first:,.0f} by week {week}" + (
                            "" if rest <= 0.5 else f", the remaining {rest:,.0f} by week {later}" if later is not None else
                            f"; the remaining {rest:,.0f} cannot be delivered within the horizon"))
        split = {rows.loc[i, "supplier"]: by_week[i] + after[i] for i in can if by_week[i] + after[i] > 0.5}
        answer[r] = {"material": m, "requested": Q, "week": week, "ATP": atp, "case": case, "decision": decision,
                     "from": " · ".join(f"{s} {u:,.0f}" for s, u in split.items()) or "—"}
        for i, row in rows.iterrows():
            why.append({"request": r, "material": m, "supplier": row["supplier"], "capacity": row["capacity"],
                        "capacity / wk": row["capacity / wk"],
                        "− committed / wk": row["committed / wk"], "= spare / wk": row["spare / wk"],
                        "lead time (wk)": row["lead time (wk)"],
                        "weeks it can ship in time": max(week - int(row["lead time (wk)"]) + 1, 0),
                        "can deliver by the week": can[i], "asked by the week": by_week[i], "asked after": after[i]})
    answer = pd.DataFrame.from_dict(answer, orient="index").rename_axis("request").loc[requests.index]
    why = pd.DataFrame(why).set_index(["request", "supplier"]).loc[requests.index.tolist()]
    return answer, why, {r: p for r, p in plans.items() if p}


def plot_supply(suppliers, answer, plans, horizon):
    """A panel per material: what its suppliers can deliver by each week on top of our planned orders
    (before any request), each request, and what the plan accepts."""
    mats = list(dict.fromkeys(answer["material"]))
    ncols = min(3, len(mats))
    nrows = -(-len(mats) // ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(4.6 * ncols + 0.8, 2.8 * nrows + 0.6), sharex=True, squeeze=False)
    weeks = np.arange(horizon)
    for ax, m in zip(axes.flat, mats):
        rows = suppliers[suppliers["material"] == m].dropna(subset=["spare / wk"])
        line = sum(row["spare / wk"] * np.clip(weeks - row["lead time (wk)"] + 1, 0, None) for _, row in rows.iterrows())
        ax.step(weeks, np.zeros(horizon) + line, where="post", color=ATP_COLORS["atp"], linewidth=1.6,
                label="suppliers can deliver by this week (ATP)")
        asked = answer[answer["material"] == m]
        ax.scatter(asked["week"], asked["requested"], facecolors="none", edgecolors=ATP_COLORS["request"], s=40, zorder=5,
                   label="requested")
        parts = [(w, u) for r in asked.index for w, u in plans.get(r, {}).items()]
        if parts:
            ax.scatter(*zip(*parts), color=ATP_COLORS["request"], s=40, zorder=6, label="accepted")
        top = 1.3 * max([asked["requested"].max()] + [u for _, u in parts])
        ax.set_ylim(0, top)
        ax.set_title(m, fontsize=9)
        ax.yaxis.set_major_formatter(lambda v, _: f"{v:,.0f}")
        ax.tick_params(labelsize=8)
        ax.spines[["top", "right"]].set_visible(False)
    for ax in axes.flat[len(mats):]:
        ax.set_visible(False)
    for ax in axes[-1]:
        ax.set_xlabel("week", fontsize=8)
    handles = {l: h for ax in axes.flat for h, l in zip(*ax.get_legend_handles_labels())}
    fig.legend(handles.values(), handles.keys(), loc="upper center", ncols=len(handles), fontsize=8, frameon=False,
               bbox_to_anchor=(0.5, 1.0))
    plt.tight_layout(rect=(0, 0, 1, 0.92))
    plt.show()


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
                [f"our stock runs out {more_empty:,.0f} more week(s)"] if more_empty >= 1 else [])
            rows[r] = {"material": m, "case": screen.loc[r, "case"], "decision": screen.loc[r, "decision"],
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
                   "decision": screen.loc[r, "decision"],
                   "ATP": screen.loc[r, "ATP"], "delivered as planned": "—", "complete by": "—", "check": "—"}
    table = pd.DataFrame.from_dict(rows, orient="index").rename_axis("request").loc[screen.index]
    return table, customers if plans else "", pd.DataFrame(detail, columns=["material"] if not detail else None).set_index("material")


