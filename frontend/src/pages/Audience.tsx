import { BarList, Card, Empty, ErrorBox, Page, Stat } from "../components/ui";
import { useApi } from "../lib/api";
import { useFilters } from "../lib/filters";

type Tally = { rows: { label: string; count: number }[]; unknown: number };
interface DemoData {
  audience: number;
  profiled: number;
  minGroup: number;
  language: Tally;
  region: Tally;
  age: Tally;
  interests: Tally;
  profession: Tally;
}

export default function Audience() {
  const { qs } = useFilters();
  const { data, error } = useApi<DemoData>(`/demographics${qs}`, 60000);

  const block = (title: string, t: Tally | undefined, note?: string) => (
    <Card title={title} note={t?.unknown ? `${t.unknown} not inferable` : note}>
      <BarList rows={t?.rows ?? []} />
    </Card>
  );

  return (
    <Page title="Audience" sub="Aggregate, anonymised estimates inferred from public names, bios and writing.">
      <ErrorBox error={error} />
      <div className="grid g3">
        <Stat value={data?.audience ?? "—"} label="People who posted in range" />
        <Stat value={data?.profiled ?? "—"} label="Profiled by AI" />
        <Stat
          value={data?.audience ? `${Math.round((data.profiled / data.audience) * 100)}%` : "—"}
          label="Coverage"
        />
      </div>

      {data && !data.profiled ? (
        <Card className="" title="">
          <Empty>Profiles appear after the pipeline has analysed a few cycles of messages.</Empty>
        </Card>
      ) : (
        <>
          <div className="section-label">Who they are</div>
          <div className="grid g2">
            {block("Age bracket", data?.age)}
            {block("Language", data?.language)}
            {block("Region", data?.region)}
            {block("Profession", data?.profession)}
          </div>
          <div className="section-label">What they care about</div>
          {block("Interests", data?.interests, "users can have up to 3")}
        </>
      )}

      <p className="note">
        Privacy: only aggregates are exposed — no per-person demographics leave the server, and any group smaller than{" "}
        {data?.minGroup ?? 3} people is folded into “other”. Estimates are probabilistic signals, not verified facts.
      </p>
    </Page>
  );
}
