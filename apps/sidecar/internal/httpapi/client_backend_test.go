package httpapi

import (
	"testing"

	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/volume"
	"github.com/psviderski/uncloud/api/pb"
	"github.com/psviderski/uncloud/pkg/api"
	deployop "github.com/psviderski/uncloud/pkg/client/deploy/operation"
	"github.com/psviderski/uncloud/pkg/client/deploy/scheduler"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestImageUpdateResponses(t *testing.T) {
	local := []api.MachineImage{{Image: image.InspectResponse{
		ID: "sha256:image", RepoDigests: []string{"registry.example/app@sha256:current"},
	}}}

	current := imageUpdateResponses(local, []RemoteImageResponse{{Digest: "sha256:current"}})
	require.Len(t, current, 1)
	require.NotNil(t, current[0].UpdateAvailable)
	assert.False(t, *current[0].UpdateAvailable)

	outdated := imageUpdateResponses(local, []RemoteImageResponse{{Digest: "sha256:new"}})
	require.Len(t, outdated, 1)
	require.NotNil(t, outdated[0].UpdateAvailable)
	assert.True(t, *outdated[0].UpdateAvailable)

	unknown := imageUpdateResponses(local, nil)
	require.Len(t, unknown, 1)
	assert.Nil(t, unknown[0].UpdateAvailable)
}

func spreadState() *scheduler.ClusterState {
	return &scheduler.ClusterState{Machines: []*scheduler.Machine{
		{Info: &pb.MachineInfo{Id: "m1", Name: "one"}, Volumes: []volume.Volume{{Name: "data", Driver: "local"}}},
		{Info: &pb.MachineInfo{Id: "m2", Name: "two"}},
		{Info: &pb.MachineInfo{Id: "m3", Name: "three"}},
	}}
}

func TestSpreadOperationsFillEmptyMachinesThatAnswered(t *testing.T) {
	spec := api.ServiceSpec{
		Name: "alloy", Mode: api.ServiceModeGlobal,
		Container: api.ContainerSpec{
			Image:        "grafana/alloy:v1.10.0",
			VolumeMounts: []api.VolumeMount{{VolumeName: "data", ContainerPath: "/var/lib/alloy"}},
		},
		Volumes: []api.VolumeSpec{{Name: "data", Type: api.VolumeTypeVolume}},
	}
	svc := api.Service{
		ID: "svc-alloy", Name: "alloy", Mode: api.ServiceModeGlobal,
		Containers: []api.MachineServiceContainer{{MachineID: "m1", Container: api.ServiceContainer{ServiceSpec: spec}}},
	}

	// m3 didn't answer the container listing, so it may still run one.
	ops, err := spreadOperations(svc, spec, spreadState(), map[string]bool{"m1": true, "m2": true})
	require.NoError(t, err)
	require.Len(t, ops, 2)

	volumeOp, ok := ops[0].(*deployop.CreateVolumeOperation)
	require.True(t, ok)
	assert.Equal(t, "m2", volumeOp.MachineID)
	assert.Equal(t, "data", volumeOp.VolumeSpec.DockerVolumeName())

	runOp, ok := ops[1].(*deployop.RunContainerOperation)
	require.True(t, ok)
	assert.Equal(t, "m2", runOp.MachineID)
	assert.Equal(t, "svc-alloy", runOp.ServiceID)
	assert.Equal(t, spec, runOp.Spec)
}

func TestSpreadOperationsKeepPlacementAndStoppedContainers(t *testing.T) {
	spec := api.ServiceSpec{
		Name: "caddy", Mode: api.ServiceModeGlobal,
		Container: api.ContainerSpec{Image: "caddy:2.10.2"},
		Placement: api.Placement{Machines: []string{"one", "two"}},
	}
	// The container on m2 is stopped, which is someone's choice to keep.
	svc := api.Service{
		ID: "svc-caddy", Name: "caddy", Mode: api.ServiceModeGlobal,
		Containers: []api.MachineServiceContainer{
			{MachineID: "m1", Container: api.ServiceContainer{ServiceSpec: spec}},
			{MachineID: "m2", Container: api.ServiceContainer{ServiceSpec: spec}},
		},
	}

	ops, err := spreadOperations(svc, spec, spreadState(), map[string]bool{"m1": true, "m2": true, "m3": true})
	require.NoError(t, err)
	assert.Empty(t, ops, "m3 is outside the placement")
}

func TestIsDockerImageID(t *testing.T) {
	const imageID = "e7adcbed53a49b1f7b616a384fc63da069433c7772f7a05398ee5e9c0b78318e"

	assert.True(t, isDockerImageID("sha256:"+imageID))
	assert.True(t, isDockerImageID(imageID))
	assert.False(t, isDockerImageID("sha256:short"))
	assert.False(t, isDockerImageID("registry.example/app:latest"))
}

func TestImageRemoteReference(t *testing.T) {
	localImages := []api.MachineImage{{Image: image.InspectResponse{
		RepoTags:    []string{"registry.example/app:latest"},
		RepoDigests: []string{"registry.example/app@sha256:current"},
	}}}

	assert.Equal(t, "registry.example/app:latest", mustImageRemoteReference(t, localImages))

	localImages[0].Image.RepoTags = []string{"<none>:<none>"}
	assert.Equal(t, "registry.example/app@sha256:current", mustImageRemoteReference(t, localImages))
}

func TestImageRemoteReferenceRequiresRepositoryReference(t *testing.T) {
	_, err := imageRemoteReference([]api.MachineImage{{Image: image.InspectResponse{}}})
	require.EqualError(t, err, "image has no repository tag or digest")
}

func mustImageRemoteReference(t *testing.T, images []api.MachineImage) string {
	t.Helper()

	ref, err := imageRemoteReference(images)
	require.NoError(t, err)
	return ref
}
