// §6.3 section 5 — the customer stage.

import { PageTitle, Section, P, Key, Callout, Term, DocLink, AppLink, Provenance } from "@/components/docs/prose";
import { StageColumns, StageSummary } from "@/components/docs/stageRef";
import { stageColumns } from "@/components/docs/stageFacts";
import { getStage } from "@/lib/policies/stages";

export default function CustomerStage() {
  const stage = getStage("customer");
  // The count is the point of this page, so it is read rather than written.
  const cols = stageColumns("customer");
  const supplierCols = stageColumns("supplier").length;
  const plantCols = stageColumns("plant").length;

  return (
    <>
      <PageTitle lead={stage.role}>Customer stage</PageTitle>

      <Callout tone="note" title="Demand and fulfilment are set here, row by row">
        <p>
          Each customer and product row carries its own demand — mode (forecast or model),
          distribution, mean, variation and, for a triangular row, its bounds, with the uploaded
          forecast beside them — and its own fulfilment: whether it backorders, for how long and at
          what cost, and the priority, price or service target the project's allocation rule reads.
          The supplier stage has {supplierCols} columns and the plant stage {plantCols}; this one
          has {cols.length}.
        </p>
      </Callout>

      <Section id="the-grain" title="One row per customer and product">
        <P>
          What happens at the demand end: which firm serves this customer, what they pay, and what
          the model does with an order it cannot fill. The rows come from your{" "}
          <DocLink to="outbound-logistics">Outbound Logistics</DocLink> upload.
        </P>
        <P>
          A row's demand comes from its own spec when it has one — uploaded on the outbound file
          or as a <DocLink to="demand-forecasts">Demand Forecast</DocLink>, and overridable in the
          cells here — and otherwise from its product's demand, split by volume.{" "}
          <DocLink to="products">Products</DocLink> covers the product-level shape.
        </P>
        <StageSummary stage="customer" />
      </Section>

      <Section id="columns" title="Every column">
        <StageColumns
          stage="customer"
          notes={{
            primary_source: (
              <>
                Which firm serves this customer. An application routing decision — the note below
                says exactly what that means and why it is not a defect.
              </>
            ),
            sourcing_firm: <>The same kind of decision, recorded per row.</>,
            row_demand_mode: (
              <>
                <Term>forecast</Term> — the row plans week by week on an uploaded series (a{" "}
                <DocLink to="demand-forecasts">Demand Forecast</DocLink>: a quantity per period for this
                customer × product, spread evenly to weeks); the distribution only adds spread around
                it. <Term>model</Term> — a constant mean per week, drawn from the distribution.{" "}
                <Term>schedule</Term> — the customer's requested delivery schedule: you type the
                quantity for every week of the run, and the row's demand is exactly that, with no
                spread around it. Forecast is offered only on a row that has a series; empty follows
                the data (a schedule if one is entered, else the forecast, else the model).
              </>
            ),
            row_demand_schedule: (
              <>
                Units per week, from run week 0 — the project start, numbered as the Lab and the results number weeks. Each cell shows its dates. Open the cell to type each week, paste a column
                from a spreadsheet, or fill every week with one value. A week past the schedule's end has
                no demand, and the pre-run check warns when the schedule is shorter than the run. The
                schedule is saved as an override on the row; the upload is never changed.
              </>
            ),
            row_forecast: <>The uploaded series, summarized — buckets, first date, first weekly values. Read-only here.</>,
            row_demand_distribution: (
              <>
                Your override, else the outbound row's distribution, else the product's distribution
                scaled by the row's share. The edit is saved as an override; the upload is never changed.
              </>
            ),
            row_demand_mean: (
              <>
                Units per week; the mode for a triangular row. Each parameter appears only for a
                distribution that reads it: deterministic and poisson — mean; normal — mean and CV;
                triangularAV — mean and ±; triangular — min, mode, max. Under a forecast the series is
                the mean, so only the spread is asked for (triangular keeps min / mode / max as its
                shape). An empty distribution runs the product's, scaled by the row's share.
              </>
            ),
            row_demand_variation: (
              <>
                Read by the distribution: the CV for normal, the ± fraction for triangularAV. The
                cell's note says which, for its row.
              </>
            ),
            backorder_allowed: (
              <>
                Whether this row waits for supply (backorder) or loses what cannot be shipped this
                week. An empty cell shows, greyed, the project value it inherits.
              </>
            ),
            max_backorder_days: (
              <>
                How long the row's backlog may wait before it is lost. The engine steps in weeks,
                so the days become whole weeks, rounded half up — 3 days is 0 weeks, 4 is 1, 10 is
                1, 11 is 2 — and the cell's note shows the weeks the run will use.
              </>
            ),
            backorder_cost_per_day: <>Per unit per day the row's backlog waits; the run charges it weekly (× 7).</>,
            row_priority: (
              <>
                Under the <Term>priority</Term> and <Term>sla_tier</Term> rules: higher is served
                first. Empty is the customer's priority weight, else 1.
              </>
            ),
            price: (
              <>
                Under <Term>revenue_max</Term>: the highest-priced row is served first. Empty is the
                outbound row's unit price, else the product's sell price.
              </>
            ),
            sla_fill_floor_pct: (
              <>
                Under <Term>sla_tier</Term>: this share of the row's demand is served before the
                rest is split by priority. Empty is the customer's contracted floor, else the
                segment's tier floor.
              </>
            ),
          }}
        />
      </Section>

      <Section id="where-the-decisions-are" title="What is per row, and what is per project">
        <Key>
          One allocation rule per project; everything that rule reads, and every backorder setting,
          per row.
        </Key>
        <P>
          The <strong>allocation rule</strong> — priority, fair share, proportional, revenue
          maximising or SLA tiers — is set once, on the <Term>Allocation</Term> line above the grid — shown only when two or
          more customers want the same product, because only then is there anything to share — at{" "}
          <AppLink to="/policies">/policies</AppLink>. Allocating between customers is a rule the
          chain applies <em>across</em> rows, so a per-row version would be several rules competing
          to be the rule; the engine reads one.
        </P>
        <P>
          What that rule reads is per row: a row's <strong>priority</strong>, its{" "}
          <strong>price</strong> and its <strong>service target</strong>. Each column appears only
          under the rule that reads it. So is <strong>backorder</strong>: one row can wait for supply
          while another of the same product loses what cannot be shipped, each with its own backlog,
          window and cost. When supply falls short, each product's units are split across its rows
          by the project's rule, a row's oldest backlog first. A project that sets none of this per
          row runs exactly as before, with that line's settings for every row.
        </P>
        <P>
          The base under these cells is your data: the{" "}
          <DocLink to="outbound-logistics">Outbound Logistics</DocLink> row (demand, price) and the
          customer's own row in the customers upload (priority weight, segment, contracted floor).
          An edit here is an override on the row; the upload is never changed.
        </P>
      </Section>

      <Section id="related" title="Related">
        <P>
          <DocLink to="how-policies-work">How policies work</DocLink> ·{" "}
          <DocLink to="outbound-logistics">Outbound Logistics</DocLink> ·{" "}
          <DocLink to="policy-catalog">The policy catalog</DocLink> ·{" "}
          <DocLink to="supplier-stage">Supplier stage</DocLink> ·{" "}
          <DocLink to="where-a-number-came-from">Where a number came from</DocLink>
        </P>
        <P>
          Edited at <AppLink to="/policies">/policies</AppLink>, under <Term>{stage.title}</Term>.
        </P>
      </Section>

      <Provenance from="the grid's own column spec, joined to the derived resolution chains" />
    </>
  );
}
