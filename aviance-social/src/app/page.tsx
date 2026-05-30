import { DashboardClient } from "@/components/DashboardClient";

export default function DashboardPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Dashboard</h1>
        <p className="text-sm text-gray-400">
          Create, schedule, and manage your social media posts.
        </p>
      </div>
      <DashboardClient />
    </div>
  );
}
