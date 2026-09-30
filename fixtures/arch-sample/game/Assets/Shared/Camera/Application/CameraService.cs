namespace Game.Camera.Application
{
    public class CameraService
    {
        private CameraPose _pose;

        public void Track(CameraPose pose)
        {
            _pose = pose;
        }
    }
}
