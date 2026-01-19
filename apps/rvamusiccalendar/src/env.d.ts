/// <reference path="../.astro/types.d.ts" />

interface Window {
	va?: (event: string, properties?: Record<string, unknown>) => void;
}
