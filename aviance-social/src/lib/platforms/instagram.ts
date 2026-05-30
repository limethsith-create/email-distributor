const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";
const OAUTH_BASE = "https://www.facebook.com/v19.0/dialog/oauth";

const APP_ID = process.env.META_APP_ID!;
const APP_SECRET = process.env.META_APP_SECRET!;

export interface InstagramProfile {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
  followers_count?: number;
}

export interface InstagramTokenResponse {
  access_token: string;
  ig_user_id: string;
  expires_in?: number;
}

/**
 * Build the Instagram OAuth authorization URL (uses Facebook OAuth).
 */
export function getAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri,
    scope: "instagram_basic,instagram_content_publish",
    response_type: "code",
    state: crypto.randomUUID(),
  });
  return `${OAUTH_BASE}?${params.toString()}`;
}

/**
 * Exchange auth code for access token and retrieve the Instagram Business Account ID.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<InstagramTokenResponse> {
  // Step 1: Exchange code for user access token
  const tokenParams = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch(
    `${GRAPH_API_BASE}/oauth/access_token?${tokenParams.toString()}`
  );

  if (!tokenRes.ok) {
    const error = await tokenRes.text();
    throw new Error(`Instagram token exchange failed: ${tokenRes.status} ${error}`);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // Step 2: Exchange for long-lived token
  const longLivedParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: APP_ID,
    client_secret: APP_SECRET,
    fb_exchange_token: accessToken,
  });

  const longLivedRes = await fetch(
    `${GRAPH_API_BASE}/oauth/access_token?${longLivedParams.toString()}`
  );

  if (!longLivedRes.ok) {
    const error = await longLivedRes.text();
    throw new Error(
      `Instagram long-lived token failed: ${longLivedRes.status} ${error}`
    );
  }

  const longLivedData = await longLivedRes.json();
  const longLivedToken = longLivedData.access_token;

  // Step 3: Get the IG Business Account ID from connected pages
  const pagesRes = await fetch(
    `${GRAPH_API_BASE}/me/accounts?fields=id,instagram_business_account&access_token=${longLivedToken}`
  );

  if (!pagesRes.ok) {
    const error = await pagesRes.text();
    throw new Error(`Instagram get pages failed: ${pagesRes.status} ${error}`);
  }

  const pagesData = await pagesRes.json();
  const pageWithIg = pagesData.data?.find(
    (p: { instagram_business_account?: { id: string } }) =>
      p.instagram_business_account
  );

  if (!pageWithIg?.instagram_business_account?.id) {
    throw new Error(
      "No Instagram Business Account found. Ensure a Facebook Page is connected to an Instagram Professional account."
    );
  }

  return {
    access_token: longLivedToken,
    ig_user_id: pageWithIg.instagram_business_account.id,
  };
}

/**
 * Get the Instagram user profile.
 */
export async function getProfile(
  accessToken: string,
  igUserId: string
): Promise<InstagramProfile> {
  const res = await fetch(
    `${GRAPH_API_BASE}/${igUserId}?fields=id,username,name,profile_picture_url,followers_count&access_token=${accessToken}`
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Instagram get profile failed: ${res.status} ${error}`);
  }

  return res.json();
}

/**
 * Publish a post to Instagram. Requires an image URL (IG does not support text-only posts).
 * Uses the two-step container creation + publish flow.
 */
export async function publishPost(
  accessToken: string,
  igUserId: string,
  content: string,
  imageUrl: string
): Promise<{ id: string }> {
  if (!imageUrl) {
    throw new Error("Instagram requires an image URL to publish a post.");
  }

  // Step 1: Create a media container
  const containerParams = new URLSearchParams({
    image_url: imageUrl,
    caption: content,
    access_token: accessToken,
  });

  const containerRes = await fetch(
    `${GRAPH_API_BASE}/${igUserId}/media?${containerParams.toString()}`,
    { method: "POST" }
  );

  if (!containerRes.ok) {
    const error = await containerRes.text();
    throw new Error(
      `Instagram create container failed: ${containerRes.status} ${error}`
    );
  }

  const containerData = await containerRes.json();
  const creationId = containerData.id;

  // Step 2: Wait briefly for container to be ready, then publish
  // In production you should poll GET /{creation-id}?fields=status_code
  // until status_code === "FINISHED". Here we do a simple retry loop.
  let attempts = 0;
  const maxAttempts = 10;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (attempts < maxAttempts) {
    const statusRes = await fetch(
      `${GRAPH_API_BASE}/${creationId}?fields=status_code&access_token=${accessToken}`
    );
    const statusData = await statusRes.json();

    if (statusData.status_code === "FINISHED") {
      break;
    }

    if (statusData.status_code === "ERROR") {
      throw new Error(
        `Instagram media container failed processing: ${JSON.stringify(statusData)}`
      );
    }

    attempts++;
    await delay(2000);
  }

  if (attempts >= maxAttempts) {
    throw new Error("Instagram media container did not finish processing in time.");
  }

  // Step 3: Publish the container
  const publishParams = new URLSearchParams({
    creation_id: creationId,
    access_token: accessToken,
  });

  const publishRes = await fetch(
    `${GRAPH_API_BASE}/${igUserId}/media_publish?${publishParams.toString()}`,
    { method: "POST" }
  );

  if (!publishRes.ok) {
    const error = await publishRes.text();
    throw new Error(`Instagram publish failed: ${publishRes.status} ${error}`);
  }

  const publishData = await publishRes.json();
  return { id: publishData.id };
}
