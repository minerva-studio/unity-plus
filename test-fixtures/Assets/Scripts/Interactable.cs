using UnityEngine;
using UnityEngine.Events;

namespace Amlos.Control.Interact
{
    public sealed class Interactable : MonoBehaviour
    {
        public UnityEvent OnCheckEnable = new();
    }
}
