import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { put } from "@vercel/blob";
import { Platform, PostStatus, MediaType } from "@prisma/client";
import { publishToPlatform } from "@/lib/platforms";

// ---------------------------------------------------------------------------
// GET /api/posts – List posts with optional filtering
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const status = searchParams.get("status") as PostStatus | null;
    const limit = parseInt(searchParams.get("limit") ?? "50", 10);
    const offset = parseInt(searchParams.get("offset") ?? "0", 10);

    const where = status ? { status } : {};

    const posts = await prisma.post.findMany({
      where,
      include: { results: true },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await prisma.post.count({ where });

    return NextResponse.json({ posts, total, limit, offset });
  } catch (error) {
    console.error("[GET /api/posts]", error);
    return NextResponse.json(
      { error: "Failed to fetch posts" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/posts – Create a new post (and optionally publish immediately)
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const content = formData.get("content") as string | null;
    if (!content?.trim()) {
      return NextResponse.json(
        { error: "content is required" },
        { status: 400 }
      );
    }

    const platformsRaw = formData.get("platforms") as string | null;
    if (!platformsRaw) {
      return NextResponse.json(
        { error: "platforms is required" },
        { status: 400 }
      );
    }

    let platforms: Platform[];
    try {
      platforms = JSON.parse(platformsRaw) as Platform[];
    } catch {
      return NextResponse.json(
        { error: "platforms must be a valid JSON array" },
        { status: 400 }
      );
    }

    if (!platforms.length) {
      return NextResponse.json(
        { error: "At least one platform is required" },
        { status: 400 }
      );
    }

    const scheduledAtRaw = formData.get("scheduledAt") as string | null;
    const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;

    const mediaTypeRaw = formData.get("mediaType") as string | null;
    const mediaType = mediaTypeRaw
      ? (mediaTypeRaw.toUpperCase() as MediaType)
      : null;

    // Handle optional media upload
    let mediaUrl: string | null = null;
    const mediaFile = formData.get("media") as File | null;
    if (mediaFile && mediaFile.size > 0) {
      const blob = await put(mediaFile.name, mediaFile, {
        access: "public",
      });
      mediaUrl = blob.url;
    }

    // Determine initial status
    const isImmediate = !scheduledAt;
    const status: PostStatus = isImmediate ? "PUBLISHING" : "SCHEDULED";

    const post = await prisma.post.create({
      data: {
        content,
        platforms,
        mediaUrl,
        mediaType,
        scheduledAt,
        status,
      },
    });

    // If no scheduledAt, publish immediately
    if (isImmediate) {
      const results: { platform: Platform; success: boolean; error?: string }[] = [];

      for (const platform of platforms) {
        const connection = await prisma.connection.findFirst({
          where: { platform },
        });

        if (!connection) {
          await prisma.postResult.create({
            data: {
              postId: post.id,
              platform,
              status: "FAILED",
              errorMessage: `No ${platform} connection found`,
            },
          });
          results.push({
            platform,
            success: false,
            error: `No ${platform} connection found`,
          });
          continue;
        }

        try {
          const result = await publishToPlatform(
            platform,
            { accessToken: connection.accessToken, accountId: connection.accountId },
            content,
            mediaUrl,
            mediaType
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
          results.push({ platform, success: true });
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
          results.push({ platform, success: false, error: errorMessage });
        }
      }

      const allSucceeded = results.every((r) => r.success);
      await prisma.post.update({
        where: { id: post.id },
        data: {
          status: allSucceeded ? "PUBLISHED" : "FAILED",
          publishedAt: allSucceeded ? new Date() : undefined,
        },
      });

      const updatedPost = await prisma.post.findUnique({
        where: { id: post.id },
        include: { results: true },
      });

      return NextResponse.json({ post: updatedPost, results }, { status: 201 });
    }

    return NextResponse.json({ post }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/posts]", error);
    return NextResponse.json(
      { error: "Failed to create post" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/posts?id=xxx – Delete a DRAFT or SCHEDULED post
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "id query param is required" },
        { status: 400 }
      );
    }

    const post = await prisma.post.findUnique({ where: { id } });

    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    if (post.status !== "DRAFT" && post.status !== "SCHEDULED") {
      return NextResponse.json(
        {
          error: `Cannot delete a post with status "${post.status}". Only DRAFT or SCHEDULED posts can be deleted.`,
        },
        { status: 400 }
      );
    }

    await prisma.post.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[DELETE /api/posts]", error);
    return NextResponse.json(
      { error: "Failed to delete post" },
      { status: 500 }
    );
  }
}
