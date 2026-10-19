import { NextResponse } from "next/server";
import { getEquipmentData } from "@/lib/sheets";

// Always fetch fresh data from the sheet — never cache/prerender this route.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getEquipmentData();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
