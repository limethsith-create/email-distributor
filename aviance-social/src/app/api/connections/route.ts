import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// ---------------------------------------------------------------------------
// GET /api/connections – List all platform connections
// ---------------------------------------------------------------------------
export async function GET() {
  try {
    const connections = await prisma.connection.findMany({
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ connections });
  } catch (error) {
    console.error("[GET /api/connections]", error);
    return NextResponse.json(
      { error: "Failed to fetch connections" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/connections?id=xxx – Remove a connection and clear tokens
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

    const connection = await prisma.connection.findUnique({ where: { id } });

    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    // Clear tokens before deleting (in case deletion fails, tokens are wiped)
    await prisma.connection.update({
      where: { id },
      data: {
        accessToken: "",
        refreshToken: null,
        tokenExpiresAt: null,
      },
    });

    await prisma.connection.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[DELETE /api/connections]", error);
    return NextResponse.json(
      { error: "Failed to delete connection" },
      { status: 500 }
    );
  }
}
