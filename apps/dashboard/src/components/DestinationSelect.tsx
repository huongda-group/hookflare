import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useDestinationsList } from "@/lib/queries/endpoints";

const ALL = "__all";

/** Destinations of `projectId` (or every project). A URL value outside the list still shows as its ID. */
export function DestinationSelect({
	projectId,
	value,
	onChange,
	label = "Destination",
}: {
	projectId?: string;
	value?: string;
	onChange: (id: string | undefined) => void;
	label?: string;
}) {
	const destinations = useDestinationsList(projectId).data?.data ?? [];
	const unknown = value && !destinations.some((d) => d.id === value);
	return (
		<Select
			value={value ?? ALL}
			onValueChange={(v) => onChange(v === ALL ? undefined : v)}
		>
			<SelectTrigger className="w-56" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All destinations</SelectItem>
				{unknown && (
					<SelectItem value={value}>
						<span className="font-mono text-xs">{value}</span>
					</SelectItem>
				)}
				{destinations.map((d) => (
					<SelectItem key={d.id} value={d.id}>
						{d.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
