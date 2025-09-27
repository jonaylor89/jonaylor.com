import React from "react";

interface CalloutProps {
  children: React.ReactNode;
  type?: "info" | "warning" | "success" | "error";
}

export default function Callout({ children, type = "info" }: CalloutProps) {
  const getBackgroundClass = () => {
    return "bg-gray-100 dark:bg-gray-800 bg-opacity-80 dark:bg-opacity-60";
  };

  const getBorderClass = () => {
    switch (type) {
      case "warning":
        return "border-l-4 border-amber-400 dark:border-amber-500";
      case "success":
        return "border-l-4 border-emerald-400 dark:border-emerald-500";
      case "error":
        return "border-l-4 border-red-400 dark:border-red-500";
      default:
        return "border-l-4 border-blue-400 dark:border-blue-500";
    }
  };

  return (
    <aside
      className={`${getBackgroundClass()} ${getBorderClass()} px-5 py-4 my-8 rounded-lg backdrop-blur-md shadow-sm transition-all duration-200 hover:shadow-md hover:backdrop-blur-lg`}
    >
      <div className="prose prose-sm dark:prose-invert max-w-none [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
        {children}
      </div>
    </aside>
  );
}
