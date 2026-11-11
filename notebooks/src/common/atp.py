# ── Available-to-promise helpers (notebook 05) ──────────────────────────────
# Reads a request against what the engine receives, runs the chain in several futures with
# and without it, and turns the result into a planner's answer. Run this cell; you do not
# need to read it.
import matplotlib.ticker as mticker
from dataclasses import dataclass, field as dc_field

REQ_ROW = "ATP-REQUEST"   # the customer row the request is added as, on a copy of your data
ATP_COLORS = {"stock": "#2a78d6", "atp": "#008300", "request": "#d9480f", "ink": "#495057"}


@dataclass
class Request:
    """A request in the engine's weeks, with what the engine received about the items it touches."""
    kind: str
    item: str
    quantity: float
    need_week: int
    ship_week: int
    transit: int
    start: pd.Timestamp
    horizon: int
    mats: list
    need: pd.DataFrame            # material_id · rate · needed (a product request)
    products: dict
    materials: dict
    suppliers: dict
    links: pd.DataFrame
    policies: dict
    confidence: float
    tol: float = 0.5
    what: str = "ship"

    @property
    def q(self):
        return 1 - self.confidence

    def to_date(self, week):
        return (self.start + pd.Timedelta(weeks=int(week))).date()

    def week_text(self, w):
        return f"week {int(w)} ({self.to_date(int(w))})"

    def lead_weeks(self, material):
        """The material's replenishment lead time in weeks: its primary supplier link's, else the shortest."""
        ls = self.links[self.links.material_id == material]
        if ls.empty:
            return None
        primary = ls[ls["primary"] == True]  # noqa: E712 — a column of booleans
        return int((primary if len(primary) else ls)["lead_time_weeks"].min())

    def suppliers_of(self, material):
        return ", ".join(sorted(self.links.supplier_id[self.links.material_id == material])) or "—"


def read_request(ev, T, bom, horizon, kind, item_id, quantity, needed_by, needed_week, start_date, delivery_weeks,
                 confidence):
    """The request in the engine's weeks. Week 0 is `start_date`, else your earliest forecast period, else today."""
    net = ev["network"]
    fc = T["demand_forecasts"]
    start = pd.Timestamp(start_date) if start_date else (
        pd.to_datetime(col(fc, "period_start")).min() if len(fc) else pd.Timestamp.today().normalize())
    if pd.isna(start):
        start = pd.Timestamp.today().normalize()
    need_week = int((pd.Timestamp(needed_by) - start).days // 7) if needed_by else int(needed_week)
    products = {p["id"]: p for p in net["products"]}
    materials = {m["id"]: m for m in net["materials"]}
    item = item_id or (next(iter(products)) if kind == "product" else next(iter(materials)))
    if item not in (products if kind == "product" else materials):
        raise Stop(f"{item!r} is not a {kind} the engine received — check ITEM against your data")
    transit, need, mats = 0, pd.DataFrame(columns=["material_id", "rate", "needed"]), [item]
    if kind == "product":
        if delivery_weeks is not None:
            transit = int(delivery_weeks)
        else:
            ob = T["outbound"]
            lt = pd.to_numeric(col(ob[col(ob, "product_id").astype(str) == item], "expected_lead_time"),
                               errors="coerce").dropna()
            transit = int(round(lt.median())) if len(lt) else 0
        need = bom[bom.product_id == item].assign(needed=lambda d: d.rate * quantity)
        mats = list(need.material_id)
    req = Request(kind=kind, item=item, quantity=quantity, need_week=need_week, ship_week=need_week - transit,
                  transit=transit, start=start, horizon=horizon, mats=mats, need=need, products=products,
                  materials=materials, suppliers={s["id"]: s for s in net["suppliers"]},
                  links=pd.DataFrame(net["supplier_links"]), policies=ev["policies"], confidence=confidence,
                  tol=max(0.5, 0.001 * quantity), what="ship" if kind == "product" else "issue")
    if not 0 <= req.ship_week < horizon:
        raise Stop(f"the request falls in week {req.ship_week}, outside the simulated weeks 0–{horizon - 1}")
    return req


def request_tables(req):
    """(the request as a short fact sheet, what it needs from each material — None for a material request)."""
    if req.kind == "material":
        m = req.materials[req.item]
        return pd.Series({
            "request": f"{req.quantity:,.0f} × {req.item} ({m.get('name') or ''}) from stock",
            "needed by": f"{req.to_date(req.need_week)} (week {req.need_week})",
            "opening stock": f"{m.get('initial_on_hand') or 0:,.0f}",
            "replenishment lead time": f"{req.lead_weeks(req.item)} wk", "suppliers": req.suppliers_of(req.item),
        }, name="").to_frame(), None
    p = req.products[req.item]
    facts = pd.Series({
        "request": f"{req.quantity:,.0f} × {req.item} ({p.get('name') or ''})",
        "needed by": f"{req.to_date(req.need_week)} (week {req.need_week})",
        "transit to customer": f"{req.transit} wk → ship by week {req.ship_week} ({req.to_date(req.ship_week)})",
        "made": str(p.get("fulfillment_mode")).upper(), "plant capacity": f"{p.get('production_capacity'):,.0f} / wk",
        "production lead time": f"{p.get('production_lead_time_weeks') or 0:g} wk",
    }, name="").to_frame()
    needs = req.need.set_index("material_id").assign(**{
        "lead time (wk)": [req.lead_weeks(m) for m in req.mats],
        "opening stock": [req.materials.get(m, {}).get("initial_on_hand") for m in req.mats],
        "suppliers": [req.suppliers_of(m) for m in req.mats],
    })[["rate", "needed", "opening stock", "lead time (wk)", "suppliers"]]
    return facts, needs


# ── the chain as it is, in several futures ──────────────────────────────────
def futures(data, pol, run, model, seeds):
    """One replication per seed with every item's weeks: {seed: {(kind, measure): weeks × items}}."""
    return {s: inspect_run(data, pol, run, model, s)[1] for s in seeds}


def _stock(worlds, material, measure="on_hand"):
    """weeks × seeds for one material."""
    return pd.DataFrame({s: f[("material", measure)][material] for s, f in worlds.items()})


def _free_stock(oh, lead):
    """For each week, the lowest stock from that week to one lead time later — what can leave then."""
    return pd.DataFrame({w: oh.iloc[w:min(w + lead, len(oh) - 1) + 1].min() for w in oh.index}).T


def _atp(req, worlds, material):
    oh, lt = _stock(worlds, material), req.lead_weeks(material) or 2
    return oh, lt, _free_stock(oh, lt).quantile(req.q, axis=1)


def stock_position(req, worlds, bom):
    """Each material the request touches, at the ship week: on hand, in transit, use, and what is free."""
    w, rows = req.ship_week, []
    for m in req.mats:
        oh, lt, atp = _atp(req, worlds, m)
        use = pd.DataFrame({s: use_of(f, bom)[m] for s, f in worlds.items()})
        rows.append({"material": m, "opening stock": req.materials.get(m, {}).get("initial_on_hand"),
                     f"on hand wk {w} (median)": oh.loc[w].median(), f"on hand wk {w} (low, {req.q:.0%})": oh.loc[w].quantile(req.q),
                     "in transit (median)": _stock(worlds, m, "in_transit").loc[w].median(),
                     "use / wk": use.mean().mean(), "lead time (wk)": lt, f"ATP wk {w}": atp.loc[w]})
    return pd.DataFrame(rows).set_index("material")


def plot_position(req, worlds, per_row=2, limit=6):
    """A panel per material: stock across the futures, what is available to promise, and the request."""
    mats = req.mats[:limit]
    ncols = min(per_row, len(mats))
    nrows = -(-len(mats) // ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(5.5 * ncols, 2.7 * nrows + 0.6), sharex=True, squeeze=False)
    for ax, m in zip(axes.flat, mats):
        oh, lt, atp = _atp(req, worlds, m)
        ax.fill_between(oh.index, oh.quantile(0.1, axis=1), oh.quantile(0.9, axis=1), color=ATP_COLORS["stock"], alpha=0.15,
                        linewidth=0, label="on hand, 10th–90th percentile")
        ax.plot(oh.index, oh.median(axis=1), color=ATP_COLORS["stock"], linewidth=1.8, label="on hand, median")
        ax.step(atp.index, atp.values, where="post", color=ATP_COLORS["atp"], linewidth=1.8,
                label=f"available to promise ({req.confidence:.0%})")
        want = req.quantity if req.kind == "material" else float(req.need.set_index("material_id").loc[m, "needed"])
        ax.scatter([req.ship_week], [want], color=ATP_COLORS["request"], zorder=5, s=40, label="the request")
        ax.axvline(req.ship_week, color=ATP_COLORS["request"], linewidth=0.8, linestyle=":")
        ax.set_title(f"{m} — needs {want:,.0f} in week {req.ship_week} · lead time {lt} wk", fontsize=9)
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
    if len(req.mats) > limit:
        print(f"showing {limit} of {len(req.mats)} materials — the table above has all of them")


# ── the request, played through the chain ───────────────────────────────────
@dataclass
class Played:
    weeks: list                                   # the candidate weeks tried
    cands: dict = dc_field(default_factory=dict)  # {mode: one row per candidate week}
    trials: dict = dc_field(default_factory=dict)
    zeros: dict = dc_field(default_factory=dict)
    splits: dict = dc_field(default_factory=dict)


def _candidate_row(req, w, delivered, harm):
    """One candidate week from per-future results: delivered (weeks × futures, capped at the
    quantity) and harm (units existing customers lost, per future)."""
    done = delivered.ge(req.quantity - req.tol)
    when = done.apply(lambda c: c[c.index >= w].idxmax() if c[c.index >= w].any() else np.nan)
    return {"week": w, "date": req.to_date(w), "on time": (when <= w).mean(),
            f"on time at {req.confidence:.0%}": delivered.loc[w].quantile(req.q),
            f"complete by (at {req.confidence:.0%})": when.quantile(req.confidence, interpolation="higher")
            if when.notna().mean() >= req.confidence else np.nan,
            "others lose (median)": harm.median() if harm is not None else np.nan}


def play_request(req, data, pol, run, model, seeds, worlds, T, search_weeks, serve_last, plan_materials):
    """Every candidate week from `search_weeks` before the ship week to `search_weeks` after, in every
    future, with and without the request. A material request is read from the stock in `worlds`."""
    w0, Q = req.ship_week, req.quantity
    out = Played(weeks=[w for w in range(w0 - search_weeks, w0 + search_weeks + 1) if 0 <= w < req.horizon])
    if req.kind == "material":
        oh, lt, _ = _atp(req, worlds, req.item)
        free = _free_stock(oh, lt).clip(upper=Q)
        out.cands["from stock"] = pd.DataFrame([_candidate_row(req, w, free, None) for w in range(req.horizon)]).set_index("week")
        return out

    item = req.item
    rule = (req.policies.get("customer_allocation") or {}).get("rule")
    ic = req.policies.get("inventory_control") or {}
    mrp_already = all(((ic.get("material_overrides") or {}).get(m) or {}).get("policy_type", ic.get("policy_type")) == "mrp"
                      for m in req.mats)
    modes = {k: v for k, v in {"as is": False, "order book": True}.items() if plan_materials in (k, "both")}
    if mrp_already and "order book" in modes:
        print("the request's materials already plan from the order book (MRP) — one answer covers both")
        modes = {"as is": False}
    row = {"customer_id": REQ_ROW, "product_id": item, "volume": 1e-6, "time_unit": "week",
           "unit_price": req.products[item].get("unit_price"), "expected_lead_time": req.transit}
    data_req = with_tables(data, outbound=pd.concat([T["outbound"], pd.DataFrame([row])], ignore_index=True))

    def with_order(schedule, order_book=False):
        """The policy copy with the request row's firm delivery schedule (units per week from week 0,
        waiting if unmet) and, for `order_book`, the request's materials planned by MRP on every lane
        that supplies them."""
        snap = copy.deepcopy(pol.snapshot)
        over = snap.setdefault("overrides", [])
        patch = {"backorder_allowed": True, "max_backorder_days": 182}
        if serve_last:
            patch["row_priority"] = 0
            if rule not in ("priority", "sla_tier"):
                snap.setdefault("defaults", {}).setdefault("fulfillment", {})["allocation"] = "priority"
        over.extend([
            {"scope": "node", "target_key": f"{REQ_ROW}::{item}", "family": "demand",
             "patch": {"row_demand_schedule": [float(x) for x in schedule]}},
            {"scope": "node", "target_key": f"{REQ_ROW}::{item}", "family": "fulfillment", "patch": patch}])
        if order_book:
            for sup, mat in req.links[req.links.material_id.isin(req.mats)][["supplier_id", "material_id"]].itertuples(index=False):
                key = f"{sup}::{mat}"
                hit = next((o for o in over if o.get("target_key") == key and o.get("family") == "inventory"), None)
                if hit:
                    hit["patch"] = {**(hit.get("patch") or {}), "type": "mrp"}
                else:
                    over.append({"scope": "node", "target_key": key, "family": "inventory", "patch": {"type": "mrp"}})
        return Policy(id=pol.id, policy_hash=None, snapshot=snap, label="with the request")

    def play(schedule, order_book):
        return {s: inspect_run(data_req, with_order(schedule, order_book), run, model, s)[1] for s in seeds}

    if serve_last and rule not in ("priority", "sla_tier"):
        print(f"your allocation rule is {rule or 'the engine default'}; for this check the request is served after "
              "every existing row (priority rule, the request last) — both sides of the comparison use it")
    print(f"{len(seeds) * (len(out.weeks) + 2) * len(modes)} one-replication runs")
    for mode, order_book in modes.items():
        out.zeros[mode] = zero = play([0.0], order_book)

        def delivered(f, s, zero=zero):
            """Units delivered to the request by each week: the product's extra deliveries plus what its
            existing customers lost to it, capped at the quantity."""
            dF = (f[("product", "fulfillment")][item] - zero[s][("product", "fulfillment")][item]).cumsum()
            dL = (f[("product", "lost_units")][item] - zero[s][("product", "lost_units")][item]).cumsum()
            return (dF + dL).clip(upper=Q)

        rows, out.trials[mode] = [], {}
        for w in out.weeks:
            trial = out.trials[mode][w] = play([0.0] * w + [Q], order_book)
            harm = pd.Series({s: max(0.0, sum((f[("product", "lost_units")][p] - zero[s][("product", "lost_units")][p]).sum()
                                              for p in f[("product", "lost_units")].columns)) for s, f in trial.items()})
            rows.append(_candidate_row(req, w, pd.DataFrame({s: delivered(f, s) for s, f in trial.items()}), harm))
        out.cands[mode] = pd.DataFrame(rows).set_index("week")

        # A split delivery, when the plant cannot make it all in one week: equal parts in the weeks up to
        # the wanted one, as many as the capacity existing customers leave free requires.
        cap = req.products[item].get("production_capacity") or np.inf
        spare = pd.Series({s: cap - f[("product", "production")][item].loc[w0] for s, f in zero.items()}).quantile(req.q)
        if out.cands[mode].loc[w0, "on time"] < req.confidence and 0 < spare < Q:
            k = min(int(np.ceil(Q / spare)), w0 + 1, search_weeks + 1)
            got = pd.DataFrame({s: delivered(f, s) for s, f in play([0.0] * (w0 - k + 1) + [Q / k] * k, order_book).items()})
            out.splits[mode] = {"parts": k, "each": Q / k, "from": w0 - k + 1,
                                "on time": got.loc[w0].ge(Q - req.tol).mean()}
    return out


def candidate_tables(req, played):
    """{mode: the candidate weeks, ready to show}."""
    c = req.confidence
    out = {}
    for mode, cand in played.cands.items():
        shown = cand.loc[[w for w in played.weeks if w in cand.index]]
        out[mode] = styled(
            shown.assign(**{"on time": shown["on time"] * 100}).rename(columns={"on time": "on time (% of futures)"}),
            fmt={"on time (% of futures)": "{:.0f}", f"on time at {c:.0%}": "{:,.0f}",
                 f"complete by (at {c:.0%})": "{:.0f}", "others lose (median)": "{:,.0f}"},
            shade=["on time (% of futures)"], cmap="Greens",
            caption=f"{req.quantity:,.0f} × {req.item}, wanted in week {req.ship_week} — materials {mode}")
    return out


def _answer(req, played, mode, lanes):
    """The planner's answer for one way of replenishing: yes, or partial + when, pull in, push back."""
    cand, w0, c, Q = played.cands[mode], req.ship_week, req.confidence, req.quantity
    at = cand.loc[w0]
    ok_weeks = [w for w in cand.index if cand.loc[w, "on time"] >= c]
    pull = max([w for w in ok_weeks if w < w0], default=None)
    push = min([w for w in ok_weeks if w > w0], default=None)
    on_time_qty, complete = at[f"on time at {c:.0%}"], at[f"complete by (at {c:.0%})"]
    harm = at["others lose (median)"]
    cost = (f" Existing customers lose a median **{harm:,.0f}** units to it." if harm >= req.tol else
            " Existing customers lose nothing to it.") if harm == harm else ""
    out = [f"#### Materials {mode}"]
    if at["on time"] >= c:
        out.append(f"**Yes — promise it.** Complete by {req.week_text(w0)} in {at['on time']:.0%} of futures.{cost}")
        if pull is not None:
            out.append(f"- It could even {req.what} from {req.week_text(pull)} (pull in).")
        return out
    out.append(f"**Not all of it on time** — complete by then in {at['on time']:.0%} of futures (the bar is {c:.0%}).{cost}")
    if on_time_qty >= req.tol:
        out.append(f"- **Partial:** {on_time_qty:,.0f} by {req.week_text(w0)}, the remaining {Q - on_time_qty:,.0f} by "
                   + (f"{req.week_text(complete)}." if complete == complete else "a date beyond the horizon at this confidence."))
    later = push if push is not None else (complete if complete == complete else None)
    if later is not None:
        out.append(f"- **Push back:** all of it by {req.week_text(later)}.")
    if pull is not None:
        out.append(f"- **Pull in:** all of it by {req.week_text(pull)}, before the capacity or stock it needs is taken.")
    split = played.splits.get(mode)
    if split:
        out.append(f"- **Split:** {split['parts']} deliveries of {split['each']:,.0f}, weeks {split['from']}–{w0} "
                   f"(the first on {req.to_date(split['from'])}) — complete on time in {split['on time']:.0%} of futures. "
                   "The plant cannot make it all in one week beside existing orders.")
    if later is None and pull is None and not split:
        out.append("- **No week within the horizon works at this confidence.**")
    if req.kind == "material":
        sup = req.links[req.links.material_id == req.item].sort_values("lead_time_weeks").iloc[0]["supplier_id"]
        spare = req.suppliers[sup]["capacity_per_week"] - lanes[lanes.supplier_id == sup]["per_week"].sum()
        out.append(f"- **Order it:** a new order from {sup} placed now arrives about {req.week_text(req.lead_weeks(req.item))} "
                   f"({sup}'s spare capacity is about {max(spare, 0):,.0f} / week).")
    return out


def answer_text(req, played, lanes):
    """The answer as Markdown: one block per way of replenishing, or one when both say the same."""
    head = f"### {req.quantity:,.0f} × {req.item}, wanted {req.week_text(req.ship_week)}" + (
        f" — at the customer {req.to_date(req.need_week)}" if req.kind == "product" else "")
    answers = {mode: _answer(req, played, mode, lanes) for mode in played.cands}
    if len(answers) == 2 and len({tuple(a[1:]) for a in answers.values()}) == 1:
        body = next(iter(answers.values()))[1:] + ["", "*The same either way: planning the request's materials from the "
                                                   "order book changes nothing here — material is not what limits it.*"]
    else:
        body = [line for a in answers.values() for line in a]
    return "\n".join([head] + body)


def plot_answer(req, played):
    """Per candidate week: the share of futures complete on time, and the units on time at the confidence level."""
    c, w0 = req.confidence, req.ship_week
    span = played.weeks if req.kind == "product" else list(range(max(0, w0 - 8), min(req.horizon, w0 + 9)))
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.2))
    width = 0.8 / len(played.cands)
    for i, (mode, cand) in enumerate(played.cands.items()):
        x = np.array(span) + (i - (len(played.cands) - 1) / 2) * width
        color = [ATP_COLORS["stock"], ATP_COLORS["atp"]][i % 2]
        axes[0].bar(x, cand.loc[span, "on time"] * 100, width=width, color=color, label=f"materials {mode}")
        axes[1].bar(x, cand.loc[span, f"on time at {c:.0%}"], width=width, color=color, label=f"materials {mode}")
    axes[0].axhline(c * 100, color=ATP_COLORS["request"], linewidth=1, linestyle="--", label=f"bar: {c:.0%}")
    axes[0].set_title(f"Complete on time, by {req.what} week (% of futures)", fontsize=10)
    axes[1].axhline(req.quantity, color=ATP_COLORS["request"], linewidth=1, linestyle="--", label="requested")
    axes[1].set_title(f"Units on time in that week ({c:.0%} of futures)", fontsize=10)
    for ax in axes:
        ax.axvline(w0, color=ATP_COLORS["ink"], linewidth=0.8, linestyle=":")
        ax.set_xlabel("week")
        ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
        ax.spines[["top", "right"]].set_visible(False)
        ax.legend(fontsize=8, frameon=False)
    plt.tight_layout()
    plt.show()


def limits(req, played):
    """A product request: {mode: units of it each constraint covers in the wanted week, the binding one marked}."""
    item, w0, low = req.item, req.ship_week, f"covers (low, {req.q:.0%})"
    cap = req.products[item].get("production_capacity") or np.nan
    rate = req.need.set_index("material_id")["rate"]
    out = {}
    for mode, zero in played.zeros.items():
        covers = {f"plant capacity ({cap:,.0f}/wk)": pd.Series(
            {s: cap - f[("product", "production")][item].loc[w0] for s, f in zero.items()})}
        for m in req.mats:
            covers[f"{m} stock (lead time {req.lead_weeks(m)} wk)"] = pd.Series(
                {s: f[("material", "on_hand")][m].loc[max(w0 - 1, 0)] / rate[m] for s, f in played.trials[mode][w0].items()})
        tab = pd.DataFrame({"covers (median)": {k: v.median() for k, v in covers.items()},
                            low: {k: v.quantile(req.q) for k, v in covers.items()}})
        tab["short of the request by"] = (req.quantity - tab[low]).clip(lower=0)
        tab["binds"] = np.where(tab[low] == tab[low].min(), "yes", "")
        out[mode] = styled(tab.rename_axis(f"week {w0}"), fmt={c: "{:,.0f}" for c in tab.columns if c != "binds"},
                           shade=["short of the request by"],
                           caption=f"Materials {mode}: units of {item} each constraint covers in week {w0}")
    return out
