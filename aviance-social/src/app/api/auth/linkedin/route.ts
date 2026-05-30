import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/platforms/linkedin";

// ---------------------------------------------------------------------------
// GET /api/auth/linkedin – Redirect to LinkedIn OAuth
// ---------------------------------------------------------------------------
export async function GET() {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const redirectUri = `${appUrl}/api/auth/callback?platform=linkedin`;
    const authUrl = getAuthUrl(redirectUri);

    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error("[GET /api/auth/linkedin]", error);
    return NextResponse.json(
      { error: "Failed to initiate LinkedIn OAuth" },
      { status: 500 }
    );
  }
}
