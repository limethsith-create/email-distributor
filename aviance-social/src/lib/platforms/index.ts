import { Platform, MediaType } from "@prisma/client";
import * as linkedin from "./linkedin";
import * as facebook from "./facebook";
import * as instagram from "./instagram";

export interface PlatformConnection {
  accessToken: string;
  accountId: string;
}

export interface PublishResult {
  platformPostId: string;
  platform: Platform;
}

/**
 * Route a publish request to the correct platform publisher.
 */
export async function publishToPlatform(
  platform: Platform,
  connection: PlatformConnection,
  content: string,
  mediaUrl?: string | null,
  mediaType?: MediaType | null
): Promise<PublishResult> {
  switch (platform) {
    case "LINKEDIN": {
      const result = await linkedin.publishPost(
        connection.accessToken,
        content,
        mediaUrl ?? undefined
      );
      return { platformPostId: result.id, platform };
    }

    case "FACEBOOK": {
      const result = await facebook.publishPost(
        connection.accessToken,
        connection.accountId,
        content,
        mediaUrl ?? undefined
      );
      return { platformPostId: result.id, platform };
    }

    case "INSTAGRAM": {
      if (!mediaUrl) {
        throw new Error("Instagram posts require an image URL.");
      }
      const result = await instagram.publishPost(
        connection.accessToken,
        connection.accountId,
        content,
        mediaUrl
      );
      return { platformPostId: result.id, platform };
    }

    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export { linkedin, facebook, instagram };
