"use client";

import { useState, useCallback, useRef } from "react";
import { useDropzone } from "react-dropzone";
import {
  Send,
  Clock,
  Image as ImageIcon,
  Video,
  Layers,
  Upload,
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Linkedin,
  Facebook,
  Instagram,
} from "lucide-react";
import { clsx } from "clsx";

type MediaType = "IMAGE" | "VIDEO" | "CAROUSEL";
type Platform = "LINKEDIN" | "FACEBOOK" | "INSTAGRAM";

interface Toast {
  type: "success" | "error";
  message: string;
}

const PLATFORMS: { id: Platform; label: string; icon: React.ElementType; color: string }[] = [
  { id: "LINKEDIN", label: "LinkedIn", icon: Linkedin, color: "text-blue-400" },
  { id: "FACEBOOK", label: "Facebook", icon: Facebook, color: "text-blue-500" },
  { id: "INSTAGRAM", label: "Instagram", icon: Instagram, color: "text-pink-400" },
];

const MEDIA_TYPES: { id: MediaType; label: string; icon: React.ElementType }[] = [
  { id: "IMAGE", label: "Image", icon: ImageIcon },
  { id: "VIDEO", label: "Video", icon: Video },
  { id: "CAROUSEL", label: "Carousel", icon: Layers },
];

export function PostComposer({ onPostCreated }: { onPostCreated?: () => void }) {
  const [content, setContent] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [mediaType, setMediaType] = useState<MediaType>("IMAGE");
  const [scheduledAt, setScheduledAt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout>();

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    toastTimeout.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    setMediaFile(file);
    const url = URL.createObjectURL(file);
    setMediaPreview(url);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp"],
      "video/*": [".mp4", ".mov", ".webm"],
    },
    maxFiles: 1,
    multiple: false,
  });

  const removeMedia = useCallback(() => {
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    setMediaFile(null);
    setMediaPreview(null);
  }, [mediaPreview]);

  const togglePlatform = useCallback((p: Platform) => {
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }, []);

  const resetForm = useCallback(() => {
    setContent("");
    removeMedia();
    setPlatforms([]);
    setMediaType("IMAGE");
    setScheduledAt("");
  }, [removeMedia]);

  const handleSubmit = useCallback(
    async (postNow: boolean) => {
      if (!content.trim()) {
        showToast({ type: "error", message: "Post content is required." });
        return;
      }
      if (platforms.length === 0) {
        showToast({ type: "error", message: "Select at least one platform." });
        return;
      }
      if (!postNow && !scheduledAt) {
        showToast({ type: "error", message: "Select a date/time to schedule." });
        return;
      }

      setIsSubmitting(true);
      try {
        const formData = new FormData();
        formData.append("content", content.trim());
        formData.append("platforms", JSON.stringify(platforms));
        formData.append("mediaType", mediaType);
        if (mediaFile) formData.append("media", mediaFile);
        if (postNow) {
          formData.append("postNow", "true");
        } else {
          formData.append("scheduledAt", new Date(scheduledAt).toISOString());
        }

        const res = await fetch("/api/posts", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(err.error || "Failed to create post");
        }

        showToast({
          type: "success",
          message: postNow ? "Post published successfully!" : "Post scheduled successfully!",
        });
        resetForm();
        onPostCreated?.();
      } catch (err) {
        showToast({
          type: "error",
          message: err instanceof Error ? err.message : "Something went wrong.",
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [content, platforms, mediaType, mediaFile, scheduledAt, showToast, resetForm, onPostCreated]
  );

  return (
    <div className="card relative">
      {/* Toast */}
      {toast && (
        <div
          className={clsx(
            "absolute -top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg transition-all duration-300 animate-in slide-in-from-top",
            toast.type === "success"
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
              : "bg-red-500/20 text-red-400 border border-red-500/30"
          )}
        >
          {toast.type === "success" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          {toast.message}
        </div>
      )}

      <h2 className="text-lg font-semibold text-white mb-4">Create Post</h2>

      {/* Content */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="What would you like to share?"
        rows={4}
        className="input-field resize-none mb-4"
        maxLength={3000}
      />
      <div className="flex justify-end mb-4">
        <span className="text-xs text-gray-500">{content.length}/3000</span>
      </div>

      {/* Media Upload */}
      {mediaPreview ? (
        <div className="relative mb-4 rounded-lg overflow-hidden border border-surface-border">
          {mediaFile?.type.startsWith("video") ? (
            <video
              src={mediaPreview}
              className="w-full max-h-48 object-cover"
              controls
            />
          ) : (
            <img
              src={mediaPreview}
              alt="Upload preview"
              className="w-full max-h-48 object-cover"
            />
          )}
          <button
            onClick={removeMedia}
            className="absolute top-2 right-2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div
          {...getRootProps()}
          className={clsx(
            "mb-4 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-all duration-200",
            isDragActive
              ? "border-accent bg-accent/5"
              : "border-surface-border hover:border-gray-500 hover:bg-surface-hover/50"
          )}
        >
          <input {...getInputProps()} />
          <Upload className="h-8 w-8 text-gray-500" />
          <p className="text-sm text-gray-400">
            {isDragActive ? "Drop your file here" : "Drag & drop media or click to browse"}
          </p>
          <p className="text-xs text-gray-600">PNG, JPG, GIF, WEBP, MP4, MOV</p>
        </div>
      )}

      {/* Media Type Selector */}
      <div className="mb-4">
        <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 block">
          Media Type
        </label>
        <div className="flex gap-2">
          {MEDIA_TYPES.map((mt) => {
            const Icon = mt.icon;
            const isSelected = mediaType === mt.id;
            return (
              <button
                key={mt.id}
                onClick={() => setMediaType(mt.id)}
                className={clsx(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200",
                  isSelected
                    ? "bg-accent/15 text-accent border border-accent/30"
                    : "bg-surface-base border border-surface-border text-gray-400 hover:text-gray-300 hover:border-gray-500"
                )}
              >
                <Icon className="h-4 w-4" />
                {mt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Platforms */}
      <div className="mb-4">
        <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 block">
          Platforms
        </label>
        <div className="flex gap-3">
          {PLATFORMS.map((p) => {
            const Icon = p.icon;
            const isSelected = platforms.includes(p.id);
            return (
              <label
                key={p.id}
                className={clsx(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer transition-all duration-200 select-none",
                  isSelected
                    ? "bg-accent/15 text-white border border-accent/30"
                    : "bg-surface-base border border-surface-border text-gray-400 hover:text-gray-300 hover:border-gray-500"
                )}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => togglePlatform(p.id)}
                  className="sr-only"
                />
                <Icon className={clsx("h-4 w-4", isSelected ? p.color : "")} />
                {p.label}
              </label>
            );
          })}
        </div>
      </div>

      {/* Schedule */}
      <div className="mb-6">
        <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 block">
          Schedule
        </label>
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="input-field max-w-xs"
          min={new Date().toISOString().slice(0, 16)}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => handleSubmit(false)}
          disabled={isSubmitting}
          className="btn-secondary flex-1"
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Clock className="h-4 w-4" />
          )}
          Schedule Post
        </button>
        <button
          onClick={() => handleSubmit(true)}
          disabled={isSubmitting}
          className="btn-primary flex-1"
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Post Now
        </button>
      </div>
    </div>
  );
}
