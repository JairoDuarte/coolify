<script>
	export let database;
	import CopyPasswordField from '$lib/components/CopyPasswordField.svelte';
</script>

<div class="flex space-x-1 py-5 font-bold">
	<div class="title">MongoDB</div>
</div>
<div class="px-10">
	<div class="grid grid-cols-3 items-center">
		<label for="rootUser">Root User</label>
		<div class="col-span-2 ">
			<CopyPasswordField
				placeholder="Generated automatically after start"
				id="rootUser"
				readonly
				disabled
				name="rootUser"
				value={database.rootUser}
			/>
		</div>
	</div>
	<div class="grid grid-cols-3 items-center">
		<label for="rootUserPassword">Root's Password</label>
		<div class="col-span-2 ">
			<CopyPasswordField
				placeholder="Generated automatically after start"
				isPasswordField={true}
				readonly
				disabled
				id="rootUserPassword"
				name="rootUserPassword"
				value={database.rootUserPassword}
			/>
		</div>
	</div>
</div>
