import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[#246b5a] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-gray-100 text-gray-700",
        teal: "border-teal-200 bg-teal-50 text-teal-700",
        green: "border-green-200 bg-green-50 text-green-700",
        red: "border-red-200 bg-red-50 text-red-700",
        yellow: "border-yellow-200 bg-yellow-50 text-yellow-800",
        outline: "border-gray-200 bg-white text-gray-700",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
