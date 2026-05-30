const LINKEDIN_API_BASE = "https://api.linkedin.com/v2";
const LINKEDIN_OAUTH_BASE = "https://www.linkedin.com/oauth/v2";

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID!;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET!;

export interface LinkedInProfile {
  id: string;
  localizedFirstName: string;
  localizedLastName: string;
  profilePicture?: string;
}

export interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

/**
 * Build the LinkedIn OAuth2 authorization URL.
 */
export function getAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "r_liteprofile r_basicprofile w_member_social",
    state: crypto.randomUUID(),
  });
  return `${LINKEDIN_OAUTH_BASE}/authorization?${params.toString()}`;
}

/**
 * Exchange an authorization code for an access token.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<LinkedInTokenResponse> {
  const res = await fetch(`${LINKEDIN_OAUTH_BASE}/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`LinkedIn token exchange failed: ${res.status} ${error}`);
  }

  return res.json();
}

/**
 * Get the authenticated user's profile.
 */
export async function getProfile(
  accessToken: string
): Promise<LinkedInProfile> {
  const res = await fetch(`${LINKEDIN_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`LinkedIn get profile failed: ${res.status} ${error}`);
  }

  return res.json();
}

/**
 * Register an image upload with LinkedIn and upload the binary.
 * Returns the asset URN for use in the post.
 */
async function uploadImage(
  accessToken: string,
  personUrn: string,
  imageUrl: string
): Promise<string> {
  // Step 1: Register the upload
  const registerRes = await fetch(
    `${LINKEDIN_API_BASE}/assets?action=registerUpload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: personUrn,
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
        },
      }),
    }
  );

  if (!registerRes.ok) {
    const error = await registerRes.text();
    throw new Error(`LinkedIn image register failed: ${registerRes.status} ${error}`);
  }

  const registerData = await registerRes.json();
  const uploadUrl =
    registerData.value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
  const asset = registerData.value.asset;

  // Step 2: Download the image from the provided URL
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new Error(`Failed to download image from ${imageUrl}`);
  }
  const imageBuffer = await imageRes.arrayBuffer();

  // Step 3: Upload the image binary to LinkedIn
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: imageBuffer,
  });

  if (!uploadRes.ok) {
    const error = await uploadRes.text();
    throw new Error(`LinkedIn image upload failed: ${uploadRes.status} ${error}`);
  }

  return asset;
}

/**
 * Publish a post to LinkedIn. Supports text-only and image posts.
 */
export async function publishPost(
  accessToken: string,
  content: string,
  imageUrl?: string
): Promise<{ id: string }> {
  // Get the person URN
  const profile = await getProfile(accessToken);
  const personUrn = `urn:li:person:${profile.id}`;

  // Build the media array if an image is provided
  let media: object[] = [];
  if (imageUrl) {
    const assetUrn = await uploadImage(accessToken, personUrn, imageUrl);
    media = [
      {
        status: "READY",
        description: { text: "" },
        media: assetUrn,
        title: { text: "" },
      },
    ];
  }

  const shareMediaCategory = imageUrl ? "IMAGE" : "NONE";

  const body = {
    author: personUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: content },
        shareMediaCategory,
        ...(media.length > 0 ? { media } : {}),
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  const res = await fetch(`${LINKEDIN_API_BASE}/ugcPosts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`LinkedIn publish failed: ${res.status} ${error}`);
  }

  const postId = res.headers.get("x-restli-id") ?? "";
  return { id: postId };
}
