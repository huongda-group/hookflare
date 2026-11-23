import { ResourcePicker } from "./ResourcePicker";

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
