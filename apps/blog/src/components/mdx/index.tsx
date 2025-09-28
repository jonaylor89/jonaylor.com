import React from "react";
import BlogImage from "./BlogImage";
import ImageGallery from "./ImageGallery";
import Callout from "./Callout";

export const mdxComponents = {
  BlogImage,
  ImageGallery,
  Callout,
  // Table components for markdown tables
  table: (props: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="overflow-x-auto my-6">
      <table
        className="min-w-full border-collapse border border-gray-300 dark:border-gray-600"
        {...props}
      />
    </div>
  ),
  thead: (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <thead className="bg-gray-50 dark:bg-gray-800" {...props} />
  ),
  tbody: (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <tbody {...props} />
  ),
  th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th
      className="border border-gray-300 dark:border-gray-600 px-4 py-2 text-left font-semibold text-gray-900 dark:text-gray-100"
      {...props}
    />
  ),
  td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td
      className="border border-gray-300 dark:border-gray-600 px-4 py-2 text-gray-800 dark:text-gray-200"
      {...props}
    />
  ),
  // Aside component for callouts
  aside: (props: React.HTMLAttributes<HTMLElement>) => (
    <aside
      className="bg-blue-50 dark:bg-blue-950/30 border-l-4 border-blue-400 dark:border-blue-500 p-4 my-6 rounded-r-md"
      {...props}
    />
  ),
  // You can add more custom MDX components here
};

export { BlogImage, ImageGallery };
