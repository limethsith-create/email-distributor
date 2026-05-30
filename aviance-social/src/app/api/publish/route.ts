import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";
import { publishToPlatform } from "@/lib/platforms";

// ---------------------------------------------------------------------------
// GET /api/publish – CRON endpoint to publish scheduled posts
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  // Verify the cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();

    // Find all scheduled posts that are due
    const duePosts = await prisma.post.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { lte: now },
      },
    });

    if (duePosts.length === 0) {
      return NextResponse.json({
        message: "No posts due for publishing",
        published: 0,
      });
    }

    const summary: Array<{
      postId: string;
      status: string;
      platforms: Array<{
        platform: Platform;
        success: boolean;
        error?: string;
      }>;
    }> = [];

    for (const post of duePosts) {
      // Mark post as currently publishing
      await prisma.post.update({
        where: { id: post.id },
        data: { status: "PUBLISHING" },
      });

      const platformResults: Array<{
        platform: Platform;
        success: boolean;
        error?: string;
      }> = [];

      for (const platform of post.platforms) {
        // Find the matching connection for this platform
        const connection = await prisma.connection.findFirst({
          where: { platform },
        });

        if (!connection) {
          const errorMessage = `No ${platform} connection found`;
          await prisma.postResult.create({
            data: {
              postId: post.id,
              platform,
              status: "FAILED",
              errorMessage,
            },
          });
          platformResults.push({
            platform,
            success: false,
            error: errorMessage,
          });
          continue;
        }

        try {
          const result = await publishToPlatform(
            platform,
            { accessToken: connection.accessToken, accountId: connection.accountId },
            post.content,
            post.mediaUrl,
            post.mediaType
          );

          await prisma.postResult.create({
            data: {
              postId: post.id,
              platform,
              status: "PUBLISHED",
              platformPostId: result.platformPostId,
              publishedAt: new Date(),
            },
          });

          platformResults.push({ platform, success: true });
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : "Unknown error";

          await prisma.postResult.create({
            data: {
              postId: post.id,
              platform,
              status: "FAILED",
              errorMessage,
            },
          });

          platformResults.push({
            platform,
            success: false,
            error: errorMessage,
          });
        }
      }

      // Determine final post status
      const allSucceeded = platformResults.every((r) => r.success);
      const anyFailed = platformResults.some((r) => !r.success);
      const finalStatus = allSucceeded ? "PUBLISHED" : "FAILED";

      await prisma.post.update({
        where: { id: post.id },
        data: {
          status: finalStatus,
          publishedAt: allSucceeded ? new Date() : undefined,
          errorMessage: anyFailed
            ? platformResults
                .filter((r) => !r.success)
                .map((r) => `${r.platform}: ${r.error}`)
                .join("; ")
            : undefined,
        },
      });

      summary.push({
        postId: post.id,
        status: finalStatus,
        platforms: platformResults,
      });
    }

    return NextResponse.json({
      message: `Processed ${duePosts.length} post(s)`,
      published: summary.filter((s) => s.status === "PUBLISHED").length,
      failed: summary.filter((s) => s.status === "FAILED").length,
      summary,
    });
  } catch (error) {
    console.error("[GET /api/publish]", error);
    return NextResponse.json(
      { error: "Failed to process scheduled posts" },
      { status: 500 }
    );
  }
}
