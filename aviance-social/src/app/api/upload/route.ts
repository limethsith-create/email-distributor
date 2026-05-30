import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

// ---------------------------------------------------------------------------
// POST /api/upload – Upload a file to Vercel Blob
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file || file.size === 0) {
      return NextResponse.json(
        { error: "file is required" },
        { status: 400 }
      );
    }

    const blob = await put(file.name, file, { access: "public" });

    return NextResponse.json({
      url: blob.url,
      pathname: blob.pathname,
    });
  } catch (error) {
    console.error("[POST /api/upload]", error);
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 }
    );
  }
}
