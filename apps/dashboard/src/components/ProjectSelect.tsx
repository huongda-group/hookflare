import { ResourcePicker } from "./ResourcePicker";

/**
 * Project filter. Public props are unchanged; the paginated named picker
 * behind it reaches beyond the old single `limit: 200` page (spec §7).
 */
export function ProjectSelect({
	value,
	onChange,
	label = "Project",
}: {
	value?: string;
	onChange: (id: string | undefined) => void;
	label?: string;
}) {
	return (
		<ResourcePicker
			kind="project"
			value={value}
			onChange={onChange}
			label={label}
			allowAll
		/>
	);
}
