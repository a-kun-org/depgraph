namespace Vsnap.AR
{
    public class SessionRunner
    {
        private CameraController _camera;
        private ColocationSession _colo;

        public void Boot(CameraController camera, ColocationSession colo)
        {
            _camera = camera;
            _colo = colo;
        }
    }
}
