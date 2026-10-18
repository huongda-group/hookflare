import { ResourcePicker } from "./ResourcePicker";

/**
 * Destinations of `projectId` (or every project). Public props are unchanged.
 * A URL value outside the loaded options still shows as its ID.
 */
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
	return (
		<ResourcePicker
			kind="destination"
			projectId={projectId}
			value={value}
			onChange={onChange}
			label={label}
			allowAll
		/>
	);
}
