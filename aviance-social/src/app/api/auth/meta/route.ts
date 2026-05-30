import { NextResponse } from "next/server";

const OAUTH_BASE = "https://www.facebook.com/v19.0/dialog/oauth";
const APP_ID = process.env.META_APP_ID!;

// ---------------------------------------------------------------------------
// GET /api/auth/meta – Redirect to Meta (Facebook + Instagram) OAuth
// ---------------------------------------------------------------------------
export async function GET() {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const redirectUri = `${appUrl}/api/auth/callback?platform=meta`;

    const params = new URLSearchParams({
      client_id: APP_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      state: crypto.randomUUID(),
      // Request scopes for both Facebook pages and Instagram
      scope: [
        "pages_manage_posts",
        "pages_read_engagement",
        "pages_show_list",
        "instagram_basic",
        "instagram_content_publish",
      ].join(","),
    });

    const authUrl = `${OAUTH_BASE}?${params.toString()}`;

    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error("[GET /api/auth/meta]", error);
    return NextResponse.json(
      { error: "Failed to initiate Meta OAuth" },
      { status: 500 }
    );
  }
}
