import { searchCompanies } from "@/lib/company-search";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.trim().length < 1) return Response.json({ results: [] });
  try {
    const results = await searchCompanies(q);
    return Response.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`company search: "${q}" failed because ${message}`);
    return Response.json({ results: [], error: message }, { status: 502 });
  }
}
