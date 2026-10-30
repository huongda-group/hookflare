import { createProjectRequest, type Project } from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { DirtyFormGuard } from "@/components/DirtyFormGuard";
import { FormSection } from "@/components/FormSection";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { applyServerIssues } from "@/lib/forms";
import { qk } from "@/lib/queries/keys";

export function FieldError({
	message,
	id,
}: {
	message?: string;
	id?: string;
}) {
	return message ? (
		<p id={id} data-field-error className="text-sm text-failure">
			{message}
		</p>
	) : null;
}

/**
 * One schema for both modes: in edit mode only `name` is registered, so `slug`
 * stays undefined; in create mode it defaults to "" and the regex rejects it.
 */
const projectForm = createProjectRequest.partial({ slug: true });

export function ProjectFormDialog({
	open,
	onOpenChange,
	project,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	project?: Project;
}) {
	// Unmount on close so every open starts from the current project.
	if (!open) return null;
	return (
		<ProjectForm project={project} onDone={() => onOpenChange(false)} />
	);
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
		z.input<typeof projectForm>,
		unknown,
		z.output<typeof projectForm>
	>({
		resolver: zodResolver(projectForm),
		defaultValues: editing ? { name: project.name } : { name: "", slug: "" },
	});
	const submit = form.handleSubmit(async (values) => {
		try {
			if (editing)
				await api.patch(`/projects/${project.id}`, { name: values.name });
			else await api.post("/projects", values);
			await qc.invalidateQueries({ queryKey: qk.projects.all });
			onDone();
		} catch (err) {
			applyServerIssues(form, err);
		}
	});
	const errors = form.formState.errors;
	return (
		<DirtyFormGuard dirty={form.formState.isDirty}>
			{(requestClose) => (
				<Dialog open onOpenChange={(o) => !o && requestClose(onDone)}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{editing ? "Edit project" : "New project"}</DialogTitle>
						</DialogHeader>
						<form onSubmit={submit} className="space-y-3">
							<FormSection title="Project">
								<div>
									<Label htmlFor="project-name">Name</Label>
									<Input id="project-name" {...form.register("name")} />
									<FieldError message={errors.name?.message} />
								</div>
								{!editing && (
									<div>
										<Label htmlFor="project-slug">Slug</Label>
										<Input id="project-slug" {...form.register("slug")} />
										<FieldError
											message={
												errors.slug?.message && `slug: ${errors.slug.message}`
											}
										/>
									</div>
								)}
							</FormSection>
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
