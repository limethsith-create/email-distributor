import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import * as linkedin from "@/lib/platforms/linkedin";
import * as facebook from "@/lib/platforms/facebook";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";
const META_APP_ID = process.env.META_APP_ID!;
const META_APP_SECRET = process.env.META_APP_SECRET!;

// ---------------------------------------------------------------------------
// GET /api/auth/callback – Handle OAuth callbacks for all platforms
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const platform = searchParams.get("platform");
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  if (error) {
    console.error(`[OAuth callback] Error from provider: ${error}`);
    return NextResponse.redirect(`${appUrl}/connections?error=${error}`);
  }

  if (!code) {
    return NextResponse.redirect(
      `${appUrl}/connections?error=missing_code`
    );
  }

  if (!platform) {
    return NextResponse.redirect(
      `${appUrl}/connections?error=missing_platform`
    );
  }

  try {
    switch (platform) {
      case "linkedin":
        await handleLinkedIn(code, appUrl);
        break;
      case "meta":
        await handleMeta(code, appUrl);
        break;
      default:
        return NextResponse.redirect(
          `${appUrl}/connections?error=unsupported_platform`
        );
    }

    return NextResponse.redirect(`${appUrl}/connections?success=true`);
  } catch (err) {
    console.error("[OAuth callback]", err);
    const message =
      err instanceof Error ? encodeURIComponent(err.message) : "unknown";
    return NextResponse.redirect(
      `${appUrl}/connections?error=${message}`
    );
  }
}

// ---------------------------------------------------------------------------
// LinkedIn: exchange code, get profile, upsert Connection
// ---------------------------------------------------------------------------
async function handleLinkedIn(code: string, appUrl: string) {
  const redirectUri = `${appUrl}/api/auth/callback?platform=linkedin`;

  const tokenData = await linkedin.exchangeCode(code, redirectUri);
  const profile = await linkedin.getProfile(tokenData.access_token);

  const accountName = `${profile.localizedFirstName} ${profile.localizedLastName}`;
  const profileUrl = `https://www.linkedin.com/in/${profile.id}`;
  const tokenExpiresAt = new Date(
    Date.now() + tokenData.expires_in * 1000
  );

  await prisma.connection.upsert({
    where: {
      platform_accountId: {
        platform: "LINKEDIN",
        accountId: profile.id,
      },
    },
    update: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      tokenExpiresAt,
      accountName,
      profileUrl,
    },
    create: {
      platform: "LINKEDIN",
      accountId: profile.id,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      tokenExpiresAt,
      accountName,
      profileUrl,
    },
  });
}

// ---------------------------------------------------------------------------
// Meta: exchange code, get pages -> save FACEBOOK connection,
//       check for Instagram business account -> save INSTAGRAM connection
// ---------------------------------------------------------------------------
async function handleMeta(code: string, appUrl: string) {
  const redirectUri = `${appUrl}/api/auth/callback?platform=meta`;

  // Exchange code for a long-lived user access token
  const tokenParams = new URLSearchParams({
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });

  const tokenRes = await fetch(
    `${GRAPH_API_BASE}/oauth/access_token?${tokenParams.toString()}`
  );

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Meta token exchange failed: ${tokenRes.status} ${err}`);
  }

  const shortLivedData = await tokenRes.json();

  // Exchange for long-lived token
  const longLivedParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    fb_exchange_token: shortLivedData.access_token,
  });

  const longLivedRes = await fetch(
    `${GRAPH_API_BASE}/oauth/access_token?${longLivedParams.toString()}`
  );

  if (!longLivedRes.ok) {
    const err = await longLivedRes.text();
    throw new Error(
      `Meta long-lived token exchange failed: ${longLivedRes.status} ${err}`
    );
  }

  const longLivedData = await longLivedRes.json();
  const userAccessToken: string = longLivedData.access_token;

  // Get Facebook Pages managed by this user
  const pagesRes = await fetch(
    `${GRAPH_API_BASE}/me/accounts?fields=id,name,access_token,category,instagram_business_account&access_token=${userAccessToken}`
  );

  if (!pagesRes.ok) {
    const err = await pagesRes.text();
    throw new Error(`Meta get pages failed: ${pagesRes.status} ${err}`);
  }

  const pagesData = await pagesRes.json();
  const pages = pagesData.data as Array<{
    id: string;
    name: string;
    access_token: string;
    category: string;
    instagram_business_account?: { id: string };
  }>;

  if (!pages || pages.length === 0) {
    throw new Error(
      "No Facebook Pages found. Make sure you manage at least one Facebook Page."
    );
  }

  // Use the first page (most common single-page setup)
  const page = pages[0];

  // Save FACEBOOK connection
  await prisma.connection.upsert({
    where: {
      platform_accountId: {
        platform: "FACEBOOK",
        accountId: page.id,
      },
    },
    update: {
      accessToken: page.access_token,
      accountName: page.name,
      profileUrl: `https://www.facebook.com/${page.id}`,
    },
    create: {
      platform: "FACEBOOK",
      accountId: page.id,
      accessToken: page.access_token,
      accountName: page.name,
      profileUrl: `https://www.facebook.com/${page.id}`,
    },
  });

  // Check for Instagram business account linked to this page
  if (page.instagram_business_account?.id) {
    const igAccountId = page.instagram_business_account.id;

    // Get Instagram profile info
    const igProfileRes = await fetch(
      `${GRAPH_API_BASE}/${igAccountId}?fields=id,username,name,profile_picture_url&access_token=${page.access_token}`
    );

    let igName = `Instagram (${page.name})`;
    let igProfileUrl: string | undefined;

    if (igProfileRes.ok) {
      const igProfile = await igProfileRes.json();
      if (igProfile.username) {
        igName = `@${igProfile.username}`;
        igProfileUrl = `https://www.instagram.com/${igProfile.username}`;
      }
    }

    await prisma.connection.upsert({
      where: {
        platform_accountId: {
          platform: "INSTAGRAM",
          accountId: igAccountId,
        },
      },
      update: {
        accessToken: page.access_token,
        accountName: igName,
        profileUrl: igProfileUrl,
      },
      create: {
        platform: "INSTAGRAM",
        accountId: igAccountId,
        accessToken: page.access_token,
        accountName: igName,
        profileUrl: igProfileUrl,
      },
    });
  }
}
