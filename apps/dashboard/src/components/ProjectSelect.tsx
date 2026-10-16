import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useProjectsList } from "@/lib/queries/projects";

const ALL = "__all";

export function ProjectSelect({
	value,
	onChange,
	label = "Project",
}: {
	value?: string;
	onChange: (id: string | undefined) => void;
	label?: string;
}) {
	const projects = useProjectsList();
	return (
		<Select
			value={value ?? ALL}
			onValueChange={(v) => onChange(v === ALL ? undefined : v)}
		>
			<SelectTrigger className="w-56" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All projects</SelectItem>
				{projects.data?.data.map((p) => (
					<SelectItem key={p.id} value={p.id}>
						{p.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
