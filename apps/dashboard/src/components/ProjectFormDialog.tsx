import { createProjectRequest, type Me, type Project } from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { DirtyFormGuard } from "@/components/DirtyFormGuard";
import { FormField } from "@/components/FormField";
import { FormSection } from "@/components/FormSection";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { applyServerIssues } from "@/lib/forms";
import { qk } from "@/lib/queries/keys";

export function FieldError({ message, id }: { message?: string; id?: string }) {
	return message ? (
		<p id={id} data-field-error className="text-sm text-failure">
			{message}
		</p>
	) : null;
}

export function ProjectFormDialog({
	open,
	onOpenChange,
	project,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	project?: Project;
}) {
	if (!open) return null;
	return <ProjectForm project={project} onDone={() => onOpenChange(false)} />;
}

function ProjectForm({
	project,
	onDone,
}: {
	project?: Project;
	onDone: () => void;
}) {
	const qc = useQueryClient();
	const editing = project !== undefined;
	const form = useForm<
		z.input<typeof createProjectRequest>,
		unknown,
		z.output<typeof createProjectRequest>
	>({
		resolver: zodResolver(createProjectRequest),
		defaultValues: { name: project?.name ?? "" },
	});
	const submit = form.handleSubmit(async (values) => {
		try {
			if (editing)
				await api.patch(`/projects/${project.id}`, { name: values.name });
			else {
				await api.post("/projects", values);
				await qc.cancelQueries({ queryKey: qk.me });
				qc.setQueryData<Me>(qk.me, (me) =>
					me ? { ...me, project_required: false } : me,
				);
			}
			await qc.invalidateQueries({ queryKey: qk.projects.all });
			onDone();
		} catch (err) {
			applyServerIssues(form, err);
		}
	});
	const errors = form.formState.errors;
	const nameField = (
		<FormField htmlFor="project-name" label="Name">
			<Input id="project-name" {...form.register("name")} />
			<FieldError message={errors.name?.message} />
		</FormField>
	);
	return (
		<DirtyFormGuard dirty={form.formState.isDirty}>
			{(requestClose) => (
				<Dialog open onOpenChange={(o) => !o && requestClose(onDone)}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{editing ? "Edit project" : "New project"}
							</DialogTitle>
						</DialogHeader>
						<form onSubmit={submit} className="space-y-3">
							{editing ? (
								<FormSection title="Project">{nameField}</FormSection>
							) : (
								nameField
							)}
							<FieldError message={errors.root?.message} />
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => requestClose(onDone)}
								>
									Cancel
								</Button>
								<Button type="submit" disabled={form.formState.isSubmitting}>
									{editing ? "Save" : "Create"}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			)}
		</DirtyFormGuard>
	);
}
